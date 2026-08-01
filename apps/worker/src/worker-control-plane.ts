import type { JobErrorClass, QueueJob } from "@inbox/domain";
import { z } from "zod";

const claimJobResponseSchema = z.object({
  attempts: z.number().int().positive().optional(),
  state: z.enum(["busy", "claimed", "duplicate"]),
});
const claimEffectResponseSchema = z.object({
  attempts: z.number().int().positive().optional(),
  state: z.enum(["busy", "claimed", "done", "uncertain"]),
});
const settlementSchema = z.object({
  delaySeconds: z.number().int().nonnegative().optional(),
  settlement: z.enum(["ack", "retry"]),
});
const rateLimitSchema = z.object({
  allowed: z.boolean(),
  count: z.number().int().nonnegative(),
  retryAt: z.string().optional(),
});

type JsonRecord = Readonly<Record<string, unknown>>;

export interface WorkerControlPlane {
  claimEffect(input: {
    readonly destination: string;
    readonly effectKey: string;
    readonly jobId: string;
  }): Promise<z.infer<typeof claimEffectResponseSchema>>;
  claimJob(job: QueueJob): Promise<z.infer<typeof claimJobResponseSchema>>;
  consumeRateLimit(input: {
    readonly bucketKey: string;
    readonly limit: number;
    readonly scope: string;
    readonly windowSeconds: number;
  }): Promise<z.infer<typeof rateLimitSchema>>;
  finishEffect(
    effectKey: string,
    input: {
      readonly errorClass?: JobErrorClass;
      readonly errorMessage?: string;
      readonly status: "done" | "failed" | "uncertain";
    },
  ): Promise<void>;
  finishJob(
    jobId: string,
    input:
      | { readonly status: "done"; readonly summary: JsonRecord }
      | {
          readonly errorClass: JobErrorClass;
          readonly errorMessage: string;
          readonly payloadDigest: string;
          readonly status: "failed";
        },
  ): Promise<z.infer<typeof settlementSchema>>;
  getCredential(name: string): Promise<unknown | null>;
  getState(key: string): Promise<unknown | null>;
  heartbeat(workerId: string, details: JsonRecord): Promise<void>;
  publishJobs(jobs: readonly QueueJob[]): Promise<number>;
  putLoginSession(
    platform: string,
    input: {
      readonly expiresAt: string;
      readonly lastError?: string | null;
      readonly state: unknown;
      readonly status: string;
    },
  ): Promise<void>;
  putState(key: string, value: unknown): Promise<void>;
  recordArticleEvent(event: {
    readonly filename: string | null;
    readonly reason: string | null;
    readonly sourceUrl: string;
    readonly status: string;
    readonly title: string;
    readonly urlFingerprint: string;
  }): Promise<void>;
  rejectInvalidJob(input: {
    readonly attempts: number;
    readonly messageId: string;
    readonly payloadDigest: string;
    readonly reason: string;
  }): Promise<void>;
}

export function createWorkerControlPlane(
  baseUrl: string,
  token: string,
  fetcher: typeof fetch = fetch,
): WorkerControlPlane {
  const request = async <T>(
    path: string,
    init: RequestInit,
    schema?: z.ZodType<T>,
  ): Promise<T> => {
    const response = await fetcher(`${baseUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    if (!response.ok) {
      throw new Error(`control plane request failed: ${response.status}`);
    }
    if (response.status === 204) return undefined as T;
    const payload: unknown = await response.json();
    return schema ? schema.parse(payload) : (payload as T);
  };

  return {
    claimEffect: (input) =>
      request(
        "/internal/effects/claim",
        { body: JSON.stringify(input), method: "POST" },
        claimEffectResponseSchema,
      ),
    claimJob: (job) =>
      request(
        "/internal/jobs/claim",
        { body: JSON.stringify({ job }), method: "POST" },
        claimJobResponseSchema,
      ),
    consumeRateLimit: (input) =>
      request(
        "/internal/rate-limits/consume",
        { body: JSON.stringify(input), method: "POST" },
        rateLimitSchema,
      ),
    finishEffect: (effectKey, input) =>
      request(`/internal/effects/${encodeURIComponent(effectKey)}/result`, {
        body: JSON.stringify(input),
        method: "PUT",
      }),
    finishJob: (jobId, input) =>
      request(
        `/internal/jobs/${encodeURIComponent(jobId)}/result`,
        { body: JSON.stringify(input), method: "PUT" },
        settlementSchema,
      ),
    async getCredential(name) {
      const response = await fetcher(
        `${baseUrl.replace(/\/$/, "")}/internal/credentials/${encodeURIComponent(name)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`control plane request failed: ${response.status}`);
      const payload = z.object({ value: z.unknown() }).parse(await response.json());
      return payload.value;
    },
    async getState(key) {
      const payload = await request<{ value: unknown }>("/internal/state/read", {
        body: JSON.stringify({ key }),
        method: "POST",
      });
      return payload.value ?? null;
    },
    heartbeat: (workerId, details) =>
      request("/internal/heartbeat", {
        body: JSON.stringify({ details, workerId }),
        method: "PUT",
      }),
    async publishJobs(jobs) {
      const payload = await request<{ queued: number }>("/internal/jobs/publish", {
        body: JSON.stringify({ jobs }),
        method: "POST",
      });
      return payload.queued;
    },
    putLoginSession: (platform, input) =>
      request(`/internal/login/${encodeURIComponent(platform)}/status`, {
        body: JSON.stringify(input),
        method: "PUT",
      }),
    putState: (key, value) =>
      request("/internal/state", {
        body: JSON.stringify({ key, value }),
        method: "PUT",
      }),
    recordArticleEvent: (event) =>
      request("/internal/article-events", {
        body: JSON.stringify(event),
        method: "POST",
      }),
    rejectInvalidJob: (input) =>
      request("/internal/jobs/reject", {
        body: JSON.stringify(input),
        method: "POST",
      }),
  };
}
