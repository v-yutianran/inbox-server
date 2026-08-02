import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type { QueueJob } from "@inbox/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createD1ControlPlaneService } from "../src/control-plane";
import { createD1TestDatabase } from "./d1-test-adapter";

const encryptionKey = Buffer.alloc(32, 7).toString("base64");
const articleJob = (suffix: string): QueueJob => ({
  createdAt: "2030-01-01T00:00:00.000Z",
  dedupeKey: `dispatch:article:${suffix}`,
  jobId: `657cb0ad-169b-4cce-92c1-${suffix.padStart(12, "0")}`,
  kind: "dispatch-item",
  payload: {
    itemKind: "article",
    requestedAt: "2030-01-01T00:00:00.000Z",
    url: `https://example.invalid/article/${suffix}`,
  },
  schemaVersion: 1,
});

describe("article retry control plane", () => {
  let currentTime: Date;
  let sqlite: DatabaseSync;

  beforeEach(() => {
    currentTime = new Date("2030-01-01T00:00:00.000Z");
    sqlite = new DatabaseSync(":memory:");
    for (const migration of [
      "0001_initial.sql",
      "0002_worker_runtime.sql",
      "0003_queue_inbox.sql",
      "0004_article_retry_safety.sql",
    ]) {
      sqlite.exec(
        readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"),
      );
    }
  });

  function service(log: (event: string, context: Readonly<Record<string, unknown>>) => void = vi.fn()) {
    return createD1ControlPlaneService({
      database: createD1TestDatabase(sqlite),
      encryptionKey,
      log,
      now: () => currentTime,
      producer: { sendBatch: async () => undefined },
    });
  }

  it("批量限速拒绝时不部分扣减并返回最晚 retryAt", async () => {
    const controlPlane = service();
    await controlPlane.consumeRateLimits([
      { bucketKey: "window", limit: 1, scope: "article:window", windowSeconds: 60 },
      { bucketKey: "daily", limit: 2, scope: "article:daily", windowSeconds: 120 },
    ]);

    const rejected = await controlPlane.consumeRateLimits([
      { bucketKey: "window", limit: 1, scope: "article:window", windowSeconds: 60 },
      { bucketKey: "daily", limit: 2, scope: "article:daily", windowSeconds: 120 },
    ]);

    expect(rejected).toEqual({
      allowed: false,
      counts: { "article:daily": 1, "article:window": 1 },
      retryAt: "2030-01-01T00:01:00.000Z",
    });
    const persisted = sqlite
      .prepare("SELECT state FROM worker_rate_limit_batches")
      .get() as { state: string };
    expect(JSON.parse(persisted.state)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ count: 1, scope: "article:daily" }),
        expect.objectContaining({ count: 1, scope: "article:window" }),
      ]),
    );
  });

  it("延期不消耗失败预算且 retryAt 前的早到重投不执行", async () => {
    const controlPlane = service();
    const job = articleJob("1");
    expect(await controlPlane.claimJob(job)).toEqual({ attempts: 1, state: "claimed" });
    expect(
      await controlPlane.finishJob(job.jobId, {
        reason: "rate_limit",
        retryAt: "2030-01-01T00:10:00.000Z",
        status: "deferred",
      }),
    ).toEqual({ delaySeconds: 300, settlement: "retry" });

    expect(await controlPlane.claimJob(job)).toEqual({
      reason: "rate_limit",
      retryAt: "2030-01-01T00:10:00.000Z",
      state: "deferred",
    });
    expect(
      sqlite
        .prepare(
          "SELECT deferral_count, failure_attempts, status FROM worker_jobs WHERE job_id = ?",
        )
        .get(job.jobId),
    ).toEqual({ deferral_count: 1, failure_attempts: 0, status: "deferred" });
  });

  it("effect busy 携带 retryAt 且不会新增 effect attempt", async () => {
    const controlPlane = service();
    const input = { destination: "archive", effectKey: "effect-1", jobId: "job-1" };
    expect(await controlPlane.claimEffect(input)).toEqual({ attempts: 1, state: "claimed" });
    expect(await controlPlane.claimEffect(input)).toEqual({
      retryAt: "2030-01-01T00:10:00.000Z",
      state: "busy",
    });
    expect(sqlite.prepare("SELECT attempts FROM worker_effects").get()).toEqual({ attempts: 1 });
  });

  it("只有三次真实失败耗尽预算并保留可恢复信封", async () => {
    const controlPlane = service();
    const job = articleJob("2");

    for (let failure = 1; failure <= 3; failure += 1) {
      expect((await controlPlane.claimJob(job)).state).toBe("claimed");
      const result = await controlPlane.finishJob(job.jobId, {
        errorClass: "retryable",
        errorMessage: `synthetic failure ${failure}`,
        payloadDigest: "synthetic-digest",
        status: "failed",
      });
      expect(result.settlement).toBe(failure === 3 ? "ack" : "retry");
      currentTime = new Date(currentTime.getTime() + 301_000);
    }

    expect(
      sqlite
        .prepare("SELECT failure_attempts, status FROM worker_jobs WHERE job_id = ?")
        .get(job.jobId),
    ).toEqual({ failure_attempts: 3, status: "dead" });
    expect(
      sqlite
        .prepare("SELECT envelope_job_id FROM worker_dead_letters WHERE job_id = ?")
        .get(job.jobId),
    ).toEqual({ envelope_job_id: job.jobId });
    expect(
      sqlite.prepare("SELECT status FROM worker_job_envelopes WHERE job_id = ?").get(job.jobId),
    ).toEqual({ status: "dead" });
  });

  it("重放 dry-run 不返回 payload，实际重放按运维键幂等暂存", async () => {
    const log = vi.fn();
    const controlPlane = service(log);
    const job = articleJob("3");
    await controlPlane.claimJob(job);
    await controlPlane.finishJob(job.jobId, {
      errorClass: "permanent",
      errorMessage: "synthetic permanent failure",
      payloadDigest: "synthetic-digest",
      status: "failed",
    });
    const publicSnapshot = await controlPlane.getQueueDlq();
    expect(JSON.stringify(publicSnapshot)).not.toMatch(
      /ciphertext|envelope_job_id|example\.invalid/,
    );

    const validated = await controlPlane.replayDeadLetter(job.jobId, {
      dryRun: true,
      idempotencyKey: "operation-1",
    });
    expect(validated).toEqual({
      published: false,
      reason: "replayable",
      replayable: true,
      status: "validated",
    });
    expect(JSON.stringify(validated)).not.toContain("example.invalid");

    const [first, second] = await Promise.all([
      controlPlane.replayDeadLetter(job.jobId, {
        dryRun: false,
        idempotencyKey: "operation-1",
      }),
      controlPlane.replayDeadLetter(job.jobId, {
        dryRun: false,
        idempotencyKey: "operation-1",
      }),
    ]);
    expect(first).toEqual(second);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM worker_inbox").get()).toEqual({
      count: 1,
    });
    expect(log).toHaveBeenCalledWith(
      "worker.job.replay_validated",
      expect.objectContaining({ jobId: job.jobId, reason: "replayable" }),
    );
    expect(log).toHaveBeenCalledWith(
      "worker.job.replay_published",
      expect.objectContaining({ jobId: job.jobId, reason: "published" }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/example\.invalid|ciphertext|payload/);
  });

  it.each(["done", "uncertain"] as const)("拒绝 %s 终态文章重放", async (status) => {
    const log = vi.fn();
    const controlPlane = service(log);
    const job = articleJob(status === "done" ? "4" : "5");
    await controlPlane.claimJob(job);
    await controlPlane.finishJob(
      job.jobId,
      status === "done"
        ? { status: "done", summary: {} }
        : { reason: "delivery_uncertain", status: "uncertain" },
    );

    expect(
      await controlPlane.replayDeadLetter(job.jobId, {
        dryRun: true,
        idempotencyKey: `operation-${status}`,
      }),
    ).toEqual({
      published: false,
      reason: `${status}_terminal`,
      replayable: false,
      status: "rejected",
    });
    expect(log).toHaveBeenCalledWith(
      "worker.job.replay_rejected",
      expect.objectContaining({ jobId: job.jobId, reason: `${status}_terminal` }),
    );
  });
});
