/**
 * eval-metrics.test.ts — Tests for evaluation metric computation
 */

import { describe, it, expect } from "vitest";
import {
  computeContradictionRate,
  computeStanceContinuity,
  computeRelationContinuity,
  computeRepetitionRate,
  computeRuntimeMetrics,
  compareMetrics,
  type EvalMetricsSnapshot,
} from "../src/eval-metrics.js";
import type { ActorBeliefRow } from "../src/types.js";

describe("computeContradictionRate", () => {
  it("returns 0 for empty beliefs", () => {
    expect(computeContradictionRate([], new Map())).toBe(0);
  });

  it("returns 0 when no sign flips occur", () => {
    const beliefs: ActorBeliefRow[] = [
      { actor_id: "a1", topic: "crypto", sentiment: 0.5, round_updated: 1 },
      { actor_id: "a1", topic: "crypto", sentiment: 0.8, round_updated: 3 },
    ];
    expect(computeContradictionRate(beliefs, new Map())).toBe(0);
  });

  it("detects contradictions when sign flips without intervening event", () => {
    const beliefs: ActorBeliefRow[] = [
      { actor_id: "a1", topic: "crypto", sentiment: 0.5, round_updated: 1 },
      { actor_id: "a1", topic: "crypto", sentiment: -0.3, round_updated: 3 },
    ];
    const rate = computeContradictionRate(beliefs, new Map());
    expect(rate).toBe(1); // 1 flip out of 1 update pair
  });

  it("does not count flip as contradiction when event justifies it", () => {
    const beliefs: ActorBeliefRow[] = [
      { actor_id: "a1", topic: "crypto", sentiment: 0.5, round_updated: 1 },
      { actor_id: "a1", topic: "crypto", sentiment: -0.3, round_updated: 3 },
    ];
    const events = new Map([["crypto", new Set([2])]]);
    expect(computeContradictionRate(beliefs, events)).toBe(0);
  });

  it("handles multiple actors independently", () => {
    const beliefs: ActorBeliefRow[] = [
      { actor_id: "a1", topic: "crypto", sentiment: 0.5, round_updated: 1 },
      { actor_id: "a1", topic: "crypto", sentiment: -0.3, round_updated: 3 },
      { actor_id: "a2", topic: "crypto", sentiment: 0.2, round_updated: 1 },
      { actor_id: "a2", topic: "crypto", sentiment: 0.6, round_updated: 3 },
    ];
    const rate = computeContradictionRate(beliefs, new Map());
    expect(rate).toBe(0.5); // 1 contradiction out of 2 update pairs
  });
});

describe("computeStanceContinuity", () => {
  it("returns 1.0 for empty input", () => {
    expect(computeStanceContinuity(new Map())).toBe(1.0);
  });

  it("returns 1.0 for identical consecutive beliefs", () => {
    const map = new Map([
      [
        "a1",
        new Map([
          [1, { crypto: 0.5, ai: 0.3 }],
          [2, { crypto: 0.5, ai: 0.3 }],
        ]),
      ],
    ]);
    expect(computeStanceContinuity(map)).toBeCloseTo(1.0);
  });

  it("returns lower score for divergent beliefs", () => {
    const map = new Map([
      [
        "a1",
        new Map([
          [1, { crypto: 0.9, ai: 0.1 }],
          [2, { crypto: -0.9, ai: -0.1 }],
        ]),
      ],
    ]);
    const score = computeStanceContinuity(map);
    expect(score).toBeLessThan(0);
  });
});

describe("computeRelationContinuity", () => {
  it("returns 1.0 for empty events", () => {
    expect(computeRelationContinuity([])).toBe(1.0);
  });

  it("returns 1.0 when no flips occur", () => {
    const events = [
      { follower_id: "a1", following_id: "a2", action: "follow" as const, round: 1 },
      { follower_id: "a1", following_id: "a2", action: "follow" as const, round: 3 },
    ];
    expect(computeRelationContinuity(events)).toBe(1.0);
  });

  it("detects flips as lower continuity", () => {
    const events = [
      { follower_id: "a1", following_id: "a2", action: "follow" as const, round: 1 },
      { follower_id: "a1", following_id: "a2", action: "unfollow" as const, round: 3 },
    ];
    const score = computeRelationContinuity(events);
    expect(score).toBe(0); // 1 flip out of 1 pair
  });
});

describe("computeRepetitionRate", () => {
  it("returns 0 for empty input", () => {
    expect(computeRepetitionRate(new Map())).toBe(0);
  });

  it("returns 0 for diverse posts", () => {
    const posts = new Map([
      [
        "a1",
        [
          "Bitcoin just crashed 20% after SEC announcement",
          "The new AI regulation framework looks promising for innovation",
          "Markets reacting strongly to the Fed decision today",
        ],
      ],
    ]);
    expect(computeRepetitionRate(posts)).toBe(0);
  });

  it("detects near-duplicate posts", () => {
    const posts = new Map([
      [
        "a1",
        [
          "Bitcoin is going to the moon and everyone should buy now",
          "Bitcoin is going to the moon and everyone should buy now immediately",
        ],
      ],
    ]);
    const rate = computeRepetitionRate(posts);
    expect(rate).toBeGreaterThan(0.5);
  });
});

describe("computeRuntimeMetrics", () => {
  it("computes averages correctly", () => {
    const rounds = [
      { wall_time_ms: 1000 },
      { wall_time_ms: 2000 },
      { wall_time_ms: 3000 },
    ];
    const result = computeRuntimeMetrics(
      rounds,
      { totalTokens: 15000, totalCostUsd: 0.45 },
      12
    );
    expect(result.avgWallTimePerRoundMs).toBe(2000);
    expect(result.totalTokens).toBe(15000);
    expect(result.totalCostUsd).toBe(0.45);
    expect(result.totalSearchRequests).toBe(12);
    expect(result.roundCount).toBe(3);
  });

  it("handles null wall times", () => {
    const rounds = [{ wall_time_ms: null }, { wall_time_ms: 1000 }];
    const result = computeRuntimeMetrics(
      rounds,
      { totalTokens: 0, totalCostUsd: 0 },
      0
    );
    expect(result.avgWallTimePerRoundMs).toBe(1000);
  });
});

describe("compareMetrics", () => {
  const makeSnapshot = (
    overrides: Partial<EvalMetricsSnapshot["quality"]> = {},
    runtimeOverrides: Partial<EvalMetricsSnapshot["runtime"]> = {}
  ): EvalMetricsSnapshot => ({
    runId: "test",
    scenario: "test",
    version: "0.1.0",
    capturedAt: new Date().toISOString(),
    config: {
      memoryProvider: "sqlite",
      feedAlgorithm: "hybrid",
      graphitiEnabled: false,
      twhinEnabled: false,
    },
    quality: {
      contradictionRate: 0.15,
      stanceContinuity: 0.72,
      relationContinuity: 0.88,
      repetitionRate: 0.05,
      ...overrides,
    },
    runtime: {
      avgWallTimePerRoundMs: 5000,
      totalTokens: 50000,
      totalCostUsd: 2.5,
      totalSearchRequests: 100,
      roundCount: 24,
      ...runtimeOverrides,
    },
  });

  it("identifies improvements in lower-is-better metrics", () => {
    const baseline = makeSnapshot({ contradictionRate: 0.20 });
    const variant = makeSnapshot({ contradictionRate: 0.10 });
    const comparisons = compareMetrics(baseline, variant);
    const contradiction = comparisons.find((c) => c.metric === "contradictionRate")!;
    expect(contradiction.direction).toBe("better");
    expect(contradiction.deltaPercent).toBe(-50);
  });

  it("identifies improvements in higher-is-better metrics", () => {
    const baseline = makeSnapshot({ stanceContinuity: 0.60 });
    const variant = makeSnapshot({ stanceContinuity: 0.80 });
    const comparisons = compareMetrics(baseline, variant);
    const stance = comparisons.find((c) => c.metric === "stanceContinuity")!;
    expect(stance.direction).toBe("better");
  });

  it("flags cost regression above 50%", () => {
    const baseline = makeSnapshot({}, { totalCostUsd: 2.0 });
    const variant = makeSnapshot({}, { totalCostUsd: 4.0 });
    const comparisons = compareMetrics(baseline, variant);
    const cost = comparisons.find((c) => c.metric === "totalCostUsd")!;
    expect(cost.direction).toBe("worse");
    expect(cost.deltaPercent).toBe(100);
  });
});
