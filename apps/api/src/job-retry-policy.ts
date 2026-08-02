import type { JobErrorClass } from "./control-plane-contract.js";

export interface RateLimitInput {
  readonly bucketKey: string;
  readonly limit: number;
  readonly scope: string;
  readonly windowSeconds: number;
}

export interface RateLimitState {
  readonly bucketKey: string;
  readonly count: number;
  readonly expiresAt: string;
  readonly scope: string;
}

export interface JobState {
  readonly failureAttempts: number;
  readonly status: "processing" | "deferred" | "failed" | "dead" | "done" | "uncertain";
}

export type RateLimitBatchDecision =
  | {
      readonly allowed: false;
      readonly counts: Readonly<Record<string, number>>;
      readonly nextStates: readonly RateLimitState[];
      readonly retryAt: string;
    }
  | {
      readonly allowed: true;
      readonly counts: Readonly<Record<string, number>>;
      readonly nextStates: readonly RateLimitState[];
    };

type JobOutcome =
  | { readonly kind: "deferred" }
  | { readonly errorClass: JobErrorClass; readonly kind: "failed" }
  | { readonly kind: "done" }
  | { readonly kind: "uncertain" };

export function calculateRetryDelaySeconds(
  retryAt: string,
  now: Date,
  maximumSeconds = 300,
): number {
  const remaining = Math.ceil((Date.parse(retryAt) - now.getTime()) / 1_000);
  return Math.max(1, Math.min(maximumSeconds, remaining));
}

export function decideJobTransition(current: JobState, outcome: JobOutcome): JobState {
  if (outcome.kind === "deferred") {
    return { failureAttempts: current.failureAttempts, status: "deferred" };
  }
  if (outcome.kind === "done" || outcome.kind === "uncertain") {
    return { failureAttempts: current.failureAttempts, status: outcome.kind };
  }
  const failureAttempts = current.failureAttempts + 1;
  return {
    failureAttempts,
    status:
      outcome.errorClass === "permanent" || failureAttempts >= 3 ? "dead" : "failed",
  };
}

export function decideRateLimitBatch(
  inputs: readonly RateLimitInput[],
  currentStates: readonly RateLimitState[],
  now: Date,
): RateLimitBatchDecision {
  const currentByKey = new Map(
    currentStates.map((state) => [`${state.scope}\u0000${state.bucketKey}`, state]),
  );
  const nextStates: RateLimitState[] = [];
  const counts: Record<string, number> = {};
  const rejectedUntil: string[] = [];

  for (const input of inputs) {
    const key = `${input.scope}\u0000${input.bucketKey}`;
    const existing = currentByKey.get(key);
    const active = existing && Date.parse(existing.expiresAt) > now.getTime();
    const count = active ? existing.count : 0;
    counts[input.scope] = count;
    if (count >= input.limit && existing) rejectedUntil.push(existing.expiresAt);
    nextStates.push({
      bucketKey: input.bucketKey,
      count: count + 1,
      expiresAt: active
        ? existing.expiresAt
        : new Date(now.getTime() + input.windowSeconds * 1_000).toISOString(),
      scope: input.scope,
    });
  }

  if (rejectedUntil.length > 0) {
    return {
      allowed: false,
      counts,
      nextStates: currentStates,
      retryAt: rejectedUntil.sort(
        (left, right) => Date.parse(right) - Date.parse(left),
      )[0]!,
    };
  }
  return {
    allowed: true,
    counts: Object.fromEntries(
      nextStates.map((state) => [state.scope, state.count]),
    ),
    nextStates,
  };
}
