import { describe, expect, it } from "vitest";

import {
  evaluateCapacityModel,
  evaluateReplicaSafety,
  type CapacityModelInput,
  type ReplicaSafetyInput,
} from "../src/capacity-model.js";

const baseline: CapacityModelInput = {
  arrivalRatePerSecond: 0.2,
  browserTaskRatio: 0.1,
  browserTaskSeconds: 12,
  concurrency: 4,
  directTaskSeconds: 1,
  duplicateCheckSeconds: 0.02,
  duplicateDeliveryRatio: 0,
  durationSeconds: 600,
  proxyReconnectCount: 0,
  proxyReconnectSeconds: 0,
};

describe("capacity model", () => {
  it.each([
    {
      expected: { backlog: 0, status: "stable" },
      input: baseline,
      name: "基线到达率低于消化率",
    },
    {
      expected: { status: "saturated" },
      input: {
        ...baseline,
        arrivalRatePerSecond: 1,
        browserTaskRatio: 0.8,
        browserTaskSeconds: 30,
      },
      name: "长浏览器任务形成积压",
    },
    {
      expected: { duplicateDeliveries: 60, externalEffects: 120 },
      input: { ...baseline, duplicateDeliveryRatio: 0.5 },
      name: "重复投递只增加去重成本而不重复外部副作用",
    },
    {
      expected: { proxyDowntimeSeconds: 180, status: "saturated" },
      input: {
        ...baseline,
        arrivalRatePerSecond: 1,
        concurrency: 1,
        proxyReconnectCount: 3,
        proxyReconnectSeconds: 60,
      },
      name: "代理重连停顿降低有效处理时间",
    },
  ])("$name", ({ expected, input }) => {
    expect(evaluateCapacityModel(input)).toMatchObject(expected);
  });

  it("拒绝非法比例和零时长", () => {
    expect(() => evaluateCapacityModel({ ...baseline, browserTaskRatio: 1.1 })).toThrow(
      /比例/,
    );
    expect(() => evaluateCapacityModel({ ...baseline, durationSeconds: 0 })).toThrow(
      /durationSeconds/,
    );
  });
});

const replicaBaseline: ReplicaSafetyInput = {
  archiveWriteLock: false,
  capacityStatus: "stable",
  effectIdempotency: true,
  leaseExclusive: true,
  loginStateIsolated: false,
  requestedReplicas: 2,
  shardOwnershipExclusive: false,
};

describe("replica safety model", () => {
  it("当前归档锁和登录态未隔离时维持单副本", () => {
    expect(evaluateReplicaSafety(replicaBaseline)).toEqual({
      activePassiveBlockers: ["archive-write-lock", "login-state-isolation"],
      activePassiveEligible: false,
      recommendedTopology: "single",
      requestedReplicas: 2,
      shardedBlockers: [
        "archive-write-lock",
        "login-state-isolation",
        "shard-ownership",
      ],
      shardedEligible: false,
      reason: "safety-gates-failed",
    });
  });

  it.each([
    ["leaseExclusive", "lease-exclusivity"],
    ["effectIdempotency", "effect-idempotency"],
    ["archiveWriteLock", "archive-write-lock"],
    ["loginStateIsolated", "login-state-isolation"],
  ] as const)("任一 active-passive 门禁 %s 失败都禁止扩副本", (field, blocker) => {
    const input = {
      ...replicaBaseline,
      archiveWriteLock: true,
      capacityStatus: "saturated" as const,
      loginStateIsolated: true,
      [field]: false,
    };

    expect(evaluateReplicaSafety(input)).toMatchObject({
      activePassiveBlockers: [blocker],
      activePassiveEligible: false,
      recommendedTopology: "single",
      reason: "safety-gates-failed",
    });
  });

  it("容量饱和且共享安全门禁通过时仅允许 active-passive", () => {
    expect(evaluateReplicaSafety({
      ...replicaBaseline,
      archiveWriteLock: true,
      capacityStatus: "saturated",
      loginStateIsolated: true,
    })).toMatchObject({
      activePassiveBlockers: [],
      activePassiveEligible: true,
      recommendedTopology: "active-passive",
      shardedBlockers: ["shard-ownership"],
      shardedEligible: false,
      reason: "active-passive-ready",
    });
  });

  it("容量仍有余量时即使门禁全绿也不扩副本", () => {
    expect(evaluateReplicaSafety({
      ...replicaBaseline,
      archiveWriteLock: true,
      loginStateIsolated: true,
      shardOwnershipExclusive: true,
    })).toMatchObject({
      activePassiveEligible: true,
      recommendedTopology: "single",
      shardedEligible: true,
      reason: "capacity-headroom",
    });
  });

  it("容量饱和且分片所有权也隔离时才建议分片", () => {
    expect(evaluateReplicaSafety({
      ...replicaBaseline,
      archiveWriteLock: true,
      capacityStatus: "saturated",
      loginStateIsolated: true,
      shardOwnershipExclusive: true,
    })).toMatchObject({
      activePassiveEligible: true,
      recommendedTopology: "sharded",
      shardedBlockers: [],
      shardedEligible: true,
      reason: "sharding-ready",
    });
  });

  it("拒绝非正整数副本数", () => {
    expect(() => evaluateReplicaSafety({ ...replicaBaseline, requestedReplicas: 0 })).toThrow(
      /requestedReplicas/,
    );
  });
});
