/**
 * activation.test.ts — Tests for actor activation per round
 *
 * Covers:
 * - Determinism: same seed → same activation
 * - Peak/off-peak/neutral hour multipliers
 * - Event boost with/without topic overlap
 * - Activity level impact (statistical)
 * - Probability clamping (floor 0, ceiling 1)
 * - Edge cases: empty actors, all zero, all max
 * - Reason strings
 */

import { describe, it, expect } from "vitest";
import type { ActorRow, RoundContext, SimEvent } from "../src/db.js";
import type { ActivationConfig } from "../src/config.js";
import { SeedablePRNG } from "../src/reproducibility.js";
import { computeActivation } from "../src/activation.js";

// ═══════════════════════════════════════════════════════
// TEST FIXTURES
// ═══════════════════════════════════════════════════════

const defaultConfig: ActivationConfig = {
  peakHours: [8, 9, 10, 12, 13, 19, 20, 21, 22],
  offPeakHours: [0, 1, 2, 3, 4, 5, 6],
  peakHourMultiplier: 1.5,
  offPeakMultiplier: 0.3,
  eventBoostMultiplier: 2.0,
  fatiguePenaltyWeight: -0.3,
};

function makeActor(overrides: Partial<ActorRow> = {}): ActorRow {
  return {
    id: "actor-1",
    run_id: "run-1",
    entity_id: null,
    archetype: "persona",
    cognition_tier: "B",
    name: "Test Actor",
    handle: "@test",
    personality: "A test persona",
    bio: "Test bio",
    age: 25,
    gender: "male",
    profession: "Student",
    region: "Bogota",
    language: "es",
    stance: "neutral",
    sentiment_bias: 0.0,
    activity_level: 0.5,
    influence_weight: 0.5,
    community_id: null,
    active_hours: null,
    follower_count: 50,
    following_count: 30,
    ...overrides,
  };
}

function makeRound(overrides: Partial<RoundContext> = {}): RoundContext {
  return {
    runId: "run-1",
    roundNum: 1,
    simTimestamp: "2024-01-01T10:00:00",
    simHour: 10,
    activeEvents: [],
    rng: new SeedablePRNG(42),
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════
// DETERMINISM
// ═══════════════════════════════════════════════════════

describe("computeActivation — determinism", () => {
  it("same seed produces identical activation", () => {
    const actors = [
      makeActor({ id: "a1", activity_level: 0.6 }),
      makeActor({ id: "a2", activity_level: 0.4 }),
      makeActor({ id: "a3", activity_level: 0.8 }),
    ];

    const result1 = computeActivation(
      actors,
      makeRound({ rng: new SeedablePRNG(42) }),
      defaultConfig
    );
    const result2 = computeActivation(
      actors,
      makeRound({ rng: new SeedablePRNG(42) }),
      defaultConfig
    );

    const ids1 = result1.activeActors.map((a) => a.id).sort();
    const ids2 = result2.activeActors.map((a) => a.id).sort();
    expect(ids1).toEqual(ids2);
  });

  it("different seed may produce different activation", () => {
    const actors = Array.from({ length: 20 }, (_, i) =>
      makeActor({ id: `a${i}`, activity_level: 0.5 })
    );

    const result1 = computeActivation(
      actors,
      makeRound({ rng: new SeedablePRNG(42) }),
      defaultConfig
    );
    const result2 = computeActivation(
      actors,
      makeRound({ rng: new SeedablePRNG(99) }),
      defaultConfig
    );

    const ids1 = result1.activeActors.map((a) => a.id).sort();
    const ids2 = result2.activeActors.map((a) => a.id).sort();
    // With 20 actors at 0.5 prob, very likely different sets
    expect(ids1).not.toEqual(ids2);
  });
});

// ═══════════════════════════════════════════════════════
// HOUR MULTIPLIERS
// ═══════════════════════════════════════════════════════

describe("computeActivation — hour multipliers", () => {
  it("peak hour increases activation rate", () => {
    const actors = Array.from({ length: 50 }, (_, i) =>
      makeActor({ id: `a${i}`, activity_level: 0.3 })
    );

    let peakCount = 0;
    let offPeakCount = 0;
    for (let seed = 0; seed < 50; seed++) {
      const peakResult = computeActivation(
        actors,
        makeRound({ simHour: 10, rng: new SeedablePRNG(seed) }),
        defaultConfig
      );
      const offPeakResult = computeActivation(
        actors,
        makeRound({ simHour: 3, rng: new SeedablePRNG(seed) }),
        defaultConfig
      );
      peakCount += peakResult.activeActors.length;
      offPeakCount += offPeakResult.activeActors.length;
    }

    expect(peakCount).toBeGreaterThan(offPeakCount);
  });

  it("actor active_hours override: actor active at non-peak hour", () => {
    const actor = makeActor({
      id: "a1",
      activity_level: 0.9,
      active_hours: JSON.stringify([15, 16, 17]),
    });
    // simHour=15 is not in global peakHours but is in actor's active_hours
    let activations = 0;
    for (let seed = 0; seed < 50; seed++) {
      const result = computeActivation(
        [actor],
        makeRound({ simHour: 15, rng: new SeedablePRNG(seed) }),
        defaultConfig
      );
      if (result.activeActors.length > 0) activations++;
    }
    // 0.9 * 1.5 = 1.35 → clamped to 1.0 → always activates
    expect(activations).toBe(50);
  });

  it("neutral hour uses multiplier 1.0", () => {
    // simHour=7 is not in peakHours or offPeakHours
    const actors = Array.from({ length: 100 }, (_, i) =>
      makeActor({ id: `a${i}`, activity_level: 0.5 })
    );

    let total = 0;
    for (let seed = 0; seed < 20; seed++) {
      const result = computeActivation(
        actors,
        makeRound({ simHour: 7, rng: new SeedablePRNG(seed) }),
        defaultConfig
      );
      total += result.activeActors.length;
    }

    // 0.5 * 1.0 = 0.5 → ~50% activation → ~50 per run, ~1000 over 20 runs
    const avg = total / 20;
    expect(avg).toBeGreaterThan(35);
    expect(avg).toBeLessThan(65);
  });
});

// ═══════════════════════════════════════════════════════
// EVENT BOOST
// ═══════════════════════════════════════════════════════

describe("computeActivation — event boost", () => {
  it("boosts activation for actors with overlapping event topics", () => {
    const actors = Array.from({ length: 50 }, (_, i) =>
      makeActor({ id: `a${i}`, activity_level: 0.2 })
    );
    const events: SimEvent[] = [{
      type: "threshold_trigger",
      round: 1,
      content: "Education crisis",
      topics: ["education"],
    }];
    const topicsMap = new Map(actors.map((a) => [a.id, ["education"]]));

    let withEvent = 0;
    let withoutEvent = 0;
    for (let seed = 0; seed < 30; seed++) {
      const boosted = computeActivation(
        actors,
        makeRound({ activeEvents: events, rng: new SeedablePRNG(seed) }),
        defaultConfig,
        topicsMap
      );
      const normal = computeActivation(
        actors,
        makeRound({ activeEvents: [], rng: new SeedablePRNG(seed) }),
        defaultConfig,
        topicsMap
      );
      withEvent += boosted.activeActors.length;
      withoutEvent += normal.activeActors.length;
    }

    expect(withEvent).toBeGreaterThan(withoutEvent);
  });

  it("no boost when actor topics don't overlap event topics", () => {
    const actor = makeActor({ id: "a1", activity_level: 0.3 });
    const events: SimEvent[] = [{
      type: "threshold_trigger",
      round: 1,
      content: "Sports update",
      topics: ["sports"],
    }];
    const topicsMap = new Map([["a1", ["education"]]]);

    let withEvent = 0;
    let withoutEvent = 0;
    for (let seed = 0; seed < 100; seed++) {
      const r1 = computeActivation(
        [actor],
        makeRound({ activeEvents: events, rng: new SeedablePRNG(seed) }),
        defaultConfig,
        topicsMap
      );
      const r2 = computeActivation(
        [actor],
        makeRound({ activeEvents: [], rng: new SeedablePRNG(seed) }),
        defaultConfig,
        topicsMap
      );
      withEvent += r1.activeActors.length;
      withoutEvent += r2.activeActors.length;
    }

    // Same rates since no topic overlap → no boost
    expect(Math.abs(withEvent - withoutEvent)).toBeLessThan(5);
  });
});

// ═══════════════════════════════════════════════════════
// ACTIVITY LEVEL & CLAMPING
// ═══════════════════════════════════════════════════════

describe("computeActivation — activity level", () => {
  it("high activity_level activates more than low", () => {
    const high = makeActor({ id: "high", activity_level: 0.9 });
    const low = makeActor({ id: "low", activity_level: 0.1 });

    let highCount = 0;
    let lowCount = 0;
    for (let seed = 0; seed < 100; seed++) {
      const result = computeActivation(
        [high, low],
        makeRound({ simHour: 7, rng: new SeedablePRNG(seed) }),
        defaultConfig
      );
      for (const a of result.activeActors) {
        if (a.id === "high") highCount++;
        else lowCount++;
      }
    }

    expect(highCount).toBeGreaterThan(lowCount * 2);
  });

  it("activity_level 0 never activates (neutral hour, no event)", () => {
    const actor = makeActor({ id: "a1", activity_level: 0 });

    let activations = 0;
    for (let seed = 0; seed < 100; seed++) {
      const result = computeActivation(
        [actor],
        makeRound({ simHour: 7, rng: new SeedablePRNG(seed) }),
        defaultConfig
      );
      activations += result.activeActors.length;
    }

    expect(activations).toBe(0);
  });

  it("probability clamped to 1.0 (always activates)", () => {
    // 0.9 * 1.5 (peak) * 2.0 (event) = 2.7 → clamped to 1.0
    const actor = makeActor({ id: "a1", activity_level: 0.9 });
    const events: SimEvent[] = [{
      type: "threshold_trigger",
      round: 1,
      content: "Big event",
      topics: ["education"],
    }];
    const topicsMap = new Map([["a1", ["education"]]]);

    let activations = 0;
    for (let seed = 0; seed < 50; seed++) {
      const result = computeActivation(
        [actor],
        makeRound({
          simHour: 10,
          activeEvents: events,
          rng: new SeedablePRNG(seed),
        }),
        defaultConfig,
        topicsMap
      );
      activations += result.activeActors.length;
    }

    expect(activations).toBe(50);
  });
});

// ═══════════════════════════════════════════════════════
// EDGE CASES
// ═══════════════════════════════════════════════════════

describe("computeActivation — edge cases", () => {
  it("empty actors list returns empty result", () => {
    const result = computeActivation([], makeRound(), defaultConfig);
    expect(result.activeActors).toHaveLength(0);
    expect(result.reasons.size).toBe(0);
  });

  it("reason string contains relevant factors", () => {
    // Force activation with high prob at peak hour with event
    const actor = makeActor({ id: "a1", activity_level: 1.0 });
    const events: SimEvent[] = [{
      type: "threshold_trigger",
      round: 1,
      content: "Event",
      topics: ["edu"],
    }];
    const topicsMap = new Map([["a1", ["edu"]]]);

    const result = computeActivation(
      [actor],
      makeRound({ simHour: 10, activeEvents: events, rng: new SeedablePRNG(42) }),
      defaultConfig,
      topicsMap
    );

    expect(result.reasons.get("a1")).toContain("peak_hour");
    expect(result.reasons.get("a1")).toContain("event_boost");
    expect(result.reasons.get("a1")).toContain("prob=");
  });

  it("works without actorTopicsMap (no event boost)", () => {
    const actor = makeActor({ id: "a1", activity_level: 1.0 });
    const result = computeActivation(
      [actor],
      makeRound({ simHour: 10, rng: new SeedablePRNG(42) }),
      defaultConfig
      // no actorTopicsMap
    );
    expect(result.activeActors).toHaveLength(1);
  });
});
