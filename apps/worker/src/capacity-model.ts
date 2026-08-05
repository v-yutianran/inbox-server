export interface CapacityModelInput {
  readonly arrivalRatePerSecond: number;
  readonly browserTaskRatio: number;
  readonly browserTaskSeconds: number;
  readonly concurrency: number;
  readonly directTaskSeconds: number;
  readonly duplicateCheckSeconds: number;
  readonly duplicateDeliveryRatio: number;
  readonly durationSeconds: number;
  readonly proxyReconnectCount: number;
  readonly proxyReconnectSeconds: number;
}

export interface CapacityModelResult {
  readonly arrivalRatePerSecond: number;
  readonly backlog: number;
  readonly consumptionRatePerSecond: number;
  readonly duplicateDeliveries: number;
  readonly externalEffects: number;
  readonly p50TaskSeconds: number;
  readonly p95TaskSeconds: number;
  readonly proxyDowntimeSeconds: number;
  readonly status: "saturated" | "stable";
  readonly uniqueArrivals: number;
}

export type ReplicaSafetyBlocker =
  | "archive-write-lock"
  | "effect-idempotency"
  | "lease-exclusivity"
  | "login-state-isolation"
  | "shard-ownership";

export interface ReplicaSafetyInput {
  readonly archiveWriteLock: boolean;
  readonly capacityStatus: CapacityModelResult["status"];
  readonly effectIdempotency: boolean;
  readonly leaseExclusive: boolean;
  readonly loginStateIsolated: boolean;
  readonly requestedReplicas: number;
  readonly shardOwnershipExclusive: boolean;
}

export interface ReplicaSafetyResult {
  readonly activePassiveBlockers: readonly ReplicaSafetyBlocker[];
  readonly activePassiveEligible: boolean;
  readonly recommendedTopology: "active-passive" | "sharded" | "single";
  readonly requestedReplicas: number;
  readonly shardedBlockers: readonly ReplicaSafetyBlocker[];
  readonly shardedEligible: boolean;
  readonly reason:
    | "active-passive-ready"
    | "capacity-headroom"
    | "safety-gates-failed"
    | "sharding-ready";
}

export function evaluateCapacityModel(input: CapacityModelInput): CapacityModelResult {
  validateInput(input);
  const uniqueArrivals = Math.floor(input.arrivalRatePerSecond * input.durationSeconds);
  const duplicateDeliveries = Math.floor(uniqueArrivals * input.duplicateDeliveryRatio);
  const proxyDowntimeSeconds = Math.min(
    input.durationSeconds,
    input.proxyReconnectCount * input.proxyReconnectSeconds,
  );
  const availableWorkerSeconds = Math.max(
    0,
    (input.durationSeconds - proxyDowntimeSeconds) * input.concurrency,
  );
  const duplicateWorkSeconds = duplicateDeliveries * input.duplicateCheckSeconds;
  const taskWorkSeconds = Math.max(0, availableWorkerSeconds - duplicateWorkSeconds);
  const averageTaskSeconds =
    input.directTaskSeconds * (1 - input.browserTaskRatio) +
    input.browserTaskSeconds * input.browserTaskRatio;
  const externalEffects = averageTaskSeconds === 0
    ? uniqueArrivals
    : Math.min(uniqueArrivals, Math.floor(taskWorkSeconds / averageTaskSeconds));
  const backlog = uniqueArrivals - externalEffects;

  return {
    arrivalRatePerSecond: input.arrivalRatePerSecond,
    backlog,
    consumptionRatePerSecond: externalEffects / input.durationSeconds,
    duplicateDeliveries,
    externalEffects,
    p50TaskSeconds: quantileTaskSeconds(input, 0.5),
    p95TaskSeconds: quantileTaskSeconds(input, 0.95),
    proxyDowntimeSeconds,
    status: backlog === 0 ? "stable" : "saturated",
    uniqueArrivals,
  };
}

export function evaluateReplicaSafety(input: ReplicaSafetyInput): ReplicaSafetyResult {
  if (!Number.isInteger(input.requestedReplicas) || input.requestedReplicas <= 0) {
    throw new Error("副本安全模型 requestedReplicas 必须是正整数");
  }

  const activePassiveBlockers = [
    ...(!input.leaseExclusive ? ["lease-exclusivity" as const] : []),
    ...(!input.effectIdempotency ? ["effect-idempotency" as const] : []),
    ...(!input.archiveWriteLock ? ["archive-write-lock" as const] : []),
    ...(!input.loginStateIsolated ? ["login-state-isolation" as const] : []),
  ];
  const shardedBlockers = [
    ...activePassiveBlockers,
    ...(!input.shardOwnershipExclusive ? ["shard-ownership" as const] : []),
  ];
  const activePassiveEligible = activePassiveBlockers.length === 0;
  const shardedEligible = shardedBlockers.length === 0;

  if (!activePassiveEligible) {
    return {
      activePassiveBlockers,
      activePassiveEligible,
      recommendedTopology: "single",
      requestedReplicas: input.requestedReplicas,
      shardedBlockers,
      shardedEligible,
      reason: "safety-gates-failed",
    };
  }
  if (input.capacityStatus === "stable" || input.requestedReplicas === 1) {
    return {
      activePassiveBlockers,
      activePassiveEligible,
      recommendedTopology: "single",
      requestedReplicas: input.requestedReplicas,
      shardedBlockers,
      shardedEligible,
      reason: "capacity-headroom",
    };
  }

  return {
    activePassiveBlockers,
    activePassiveEligible,
    recommendedTopology: shardedEligible ? "sharded" : "active-passive",
    requestedReplicas: input.requestedReplicas,
    shardedBlockers,
    shardedEligible,
    reason: shardedEligible ? "sharding-ready" : "active-passive-ready",
  };
}

function quantileTaskSeconds(input: CapacityModelInput, quantile: number): number {
  return quantile > 1 - input.browserTaskRatio
    ? input.browserTaskSeconds
    : input.directTaskSeconds;
}

function validateInput(input: CapacityModelInput): void {
  const nonNegative = [
    input.arrivalRatePerSecond,
    input.browserTaskSeconds,
    input.directTaskSeconds,
    input.duplicateCheckSeconds,
    input.durationSeconds,
    input.proxyReconnectCount,
    input.proxyReconnectSeconds,
  ];
  if (nonNegative.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("容量模型数值必须是非负有限数");
  }
  if (!Number.isInteger(input.concurrency) || input.concurrency <= 0) {
    throw new Error("容量模型 concurrency 必须是正整数");
  }
  for (const ratio of [input.browserTaskRatio, input.duplicateDeliveryRatio]) {
    if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
      throw new Error("容量模型比例必须在 0 到 1 之间");
    }
  }
  if (input.durationSeconds === 0) throw new Error("容量模型 durationSeconds 必须大于 0");
}
