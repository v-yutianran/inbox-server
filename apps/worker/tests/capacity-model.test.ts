import { describe, expect, it } from "vitest";

import { evaluateCapacityModel, type CapacityModelInput } from "../src/capacity-model.js";

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
