/**
 * report.test.ts — Tests for the SQL-to-Report pipeline
 *
 * Covers:
 * - computeMetrics: run_id, hypothesis, posts_per_round, sentiment curves,
 *   top actors, tier breakdown, fatigue curves, event_rounds, missing run
 * - generateNarrative: calls LLM with formatted metrics
 * - generateReport: with and without LLM provider
 * - Policy: zero JSON.parse in report.ts
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { SQLiteGraphStore } from "../src/db.js";
import { MockLLMClient } from "../src/llm.js";
import { computeMetrics, generateNarrative, generateReport } from "../src/report.js";

// ═══════════════════════════════════════════════════════
// TEST HELPER
// ═══════════════════════════════════════════════════════

function setupReportStore(): { store: SQLiteGraphStore; runId: string } {
  const store = new SQLiteGraphStore(":memory:");
  const runId = "report-run";
  store.createRun({
    id: runId,
    started_at: new Date().toISOString(),
    seed: 42,
    config_snapshot: "{}",
    hypothesis: "Negative sentiment spreads faster than positive",
    graph_revision_id: "test",
    status: "completed",
    total_rounds: 10,
  });

  // Add some actors
  for (let i = 0; i < 3; i++) {
    store.addActor({
      id: `actor-${i}`,
      run_id: runId,
      entity_id: null,
      archetype: "persona",
      cognition_tier: i === 0 ? "A" : i === 1 ? "B" : "C",
      name: `Actor ${i}`,
      handle: `actor${i}`,
      personality: "Test persona",
      bio: null,
      age: null,
      gender: null,
      profession: null,
      region: null,
      language: "en",
      stance: "neutral",
      sentiment_bias: 0,
      activity_level: 0.5,
      influence_weight: 0.3,
      community_id: null,
      active_hours: null,
      follower_count: 10,
      following_count: 5,
    });
  }

  // Add posts across rounds
  for (let round = 0; round < 5; round++) {
    for (let a = 0; a < 3; a++) {
      store.addPost({
        id: `post-${round}-${a}`,
        run_id: runId,
        author_id: `actor-${a}`,
        content: `Post by actor ${a} in round ${round}`,
        round_num: round,
        sim_timestamp: "2024-01-01T00:00:00",
        likes: round * 2,
        reposts: 0,
        comments: 0,
        reach: (round + 1) * 10,
        sentiment: -0.3,
      });
      store.addPostTopic(`post-${round}-${a}`, "education");
    }
  }

  // Add round data
  for (let round = 0; round < 5; round++) {
    store.upsertRound({
      num: round,
      run_id: runId,
      sim_time: "2024-01-01T00:00:00",
      active_actors: 3,
      total_posts: 3,
      total_actions: 3,
      tier_a_calls: 1,
      tier_b_calls: 1,
      tier_c_actions: 1,
      events: round === 0 ? JSON.stringify([{ type: "scheduled", content: "Breaking news", topics: ["education"] }]) : undefined,
    });
  }

  // Add narratives
  store.addNarrative({
    id: "narr-education",
    run_id: runId,
    topic: "education",
    first_round: 0,
    peak_round: 3,
    current_intensity: 0.7,
    total_posts: 15,
    dominant_sentiment: -0.3,
  });

  return { store, runId };
}

// ═══════════════════════════════════════════════════════
// computeMetrics
// ═══════════════════════════════════════════════════════

describe("computeMetrics", () => {
  it("returns correct run_id and hypothesis", () => {
    const { store, runId } = setupReportStore();
    const metrics = computeMetrics(store, runId);

    expect(metrics.run_id).toBe(runId);
    expect(metrics.hypothesis).toBe("Negative sentiment spreads faster than positive");

    store.close();
  });

  it("computes posts_per_round correctly", () => {
    const { store, runId } = setupReportStore();
    const metrics = computeMetrics(store, runId);

    // We have 5 rounds of data
    expect(metrics.posts_per_round.length).toBeGreaterThanOrEqual(5);

    // Round 0 has 3 actor posts + 1 system event post = 4, rounds 1-4 have 3 each
    const round0 = metrics.posts_per_round.find((r) => r.round === 0);
    expect(round0).toBeDefined();
    expect(round0!.posts).toBeGreaterThanOrEqual(3);

    const round1 = metrics.posts_per_round.find((r) => r.round === 1);
    expect(round1).toBeDefined();
    expect(round1!.posts).toBe(3);

    store.close();
  });

  it("includes sentiment curves from narratives", () => {
    const { store, runId } = setupReportStore();
    const metrics = computeMetrics(store, runId);

    expect(metrics.sentiment_curves.length).toBe(1);
    const education = metrics.sentiment_curves[0];
    expect(education.topic).toBe("education");
    expect(education.dominant_sentiment).toBe(-0.3);
    expect(education.intensity).toBe(0.7);
    expect(education.peak_round).toBe(3);
    expect(education.total_posts).toBe(15);

    store.close();
  });

  it("includes top actors by reach", () => {
    const { store, runId } = setupReportStore();
    const metrics = computeMetrics(store, runId);

    // We added 3 persona actors + 1 system actor, all with posts
    expect(metrics.top_actors_by_reach.length).toBeGreaterThanOrEqual(3);

    // Each actor should have actor_id, actor_name, total_reach, etc.
    for (const actor of metrics.top_actors_by_reach) {
      expect(actor.actor_id).toBeDefined();
      expect(actor.actor_name).toBeDefined();
      expect(typeof actor.total_reach).toBe("number");
      expect(typeof actor.total_likes).toBe("number");
      expect(typeof actor.total_posts).toBe("number");
      expect(actor.cognition_tier).toBeDefined();
    }

    store.close();
  });

  it("includes tier breakdown", () => {
    const { store, runId } = setupReportStore();
    const metrics = computeMetrics(store, runId);

    // 5 rounds, each with 1 tier_a, 1 tier_b, 1 tier_c
    expect(metrics.tier_breakdown.tier_a_calls).toBe(5);
    expect(metrics.tier_breakdown.tier_b_calls).toBe(5);
    expect(metrics.tier_breakdown.tier_c_actions).toBe(5);

    store.close();
  });

  it("includes fatigue curves with status", () => {
    const { store, runId } = setupReportStore();
    const metrics = computeMetrics(store, runId);

    expect(metrics.fatigue_curves.length).toBe(1);
    const education = metrics.fatigue_curves[0];
    expect(education.topic).toBe("education");
    expect(education.current_intensity).toBe(0.7);
    // 0.7 >= 0.5 => "active"
    expect(education.status).toBe("active");
    expect(education.peak_round).toBe(3);

    store.close();
  });

  it("includes event_rounds", () => {
    const { store, runId } = setupReportStore();
    const metrics = computeMetrics(store, runId);

    // We persisted an event payload on round 0
    expect(metrics.event_rounds).toContain(0);

    store.close();
  });

  it("throws on missing run", () => {
    const store = new SQLiteGraphStore(":memory:");

    expect(() => computeMetrics(store, "nonexistent-run")).toThrow(
      "Run not found: nonexistent-run"
    );

    store.close();
  });
});

// ═══════════════════════════════════════════════════════
// generateNarrative
// ═══════════════════════════════════════════════════════

describe("generateNarrative", () => {
  it("calls report provider with formatted metrics", async () => {
    const { store, runId } = setupReportStore();
    const metrics = computeMetrics(store, runId);

    const mock = new MockLLMClient();
    mock.setResponse(
      "Rounds completed",
      "The simulation revealed significant patterns in negative sentiment propagation."
    );

    const narrative = await generateNarrative(mock, metrics);
    expect(narrative).toBe(
      "The simulation revealed significant patterns in negative sentiment propagation."
    );

    store.close();
  });
});

// ═══════════════════════════════════════════════════════
// generateReport
// ═══════════════════════════════════════════════════════

describe("generateReport", () => {
  it("returns metrics and null narrative without LLM", async () => {
    const { store, runId } = setupReportStore();

    const report = await generateReport(store, runId);
    expect(report.metrics).toBeDefined();
    expect(report.metrics.run_id).toBe(runId);
    expect(report.narrative).toBeNull();

    store.close();
  });

  it("returns metrics and narrative with MockLLMClient", async () => {
    const { store, runId } = setupReportStore();
    const mock = new MockLLMClient();
    mock.setResponse(
      "Rounds completed",
      "A comprehensive analysis of the simulation run."
    );

    const report = await generateReport(store, runId, mock);
    expect(report.metrics).toBeDefined();
    expect(report.metrics.run_id).toBe(runId);
    expect(report.narrative).toBe("A comprehensive analysis of the simulation run.");

    store.close();
  });
});

// ═══════════════════════════════════════════════════════
// Policy: zero JSON.parse in report.ts
// ═══════════════════════════════════════════════════════

describe("report.ts policy", () => {
  it("report.ts contains zero JSON.parse calls", () => {
    const src = readFileSync(
      new URL("../src/report.ts", import.meta.url),
      "utf-8"
    );
    expect(src).not.toContain("JSON.parse");
  });
});
