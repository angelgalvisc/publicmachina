/**
 * telemetry.test.ts — Tests for telemetry logging, sanitization, round stats
 *
 * Covers:
 * - logAction: inserts telemetry rows with/without llmStats
 * - logAction: sanitizes detail before storage
 * - sanitizeDetail: redacts sk- keys, Bearer tokens, JSON keys
 * - sanitizeDetail: leaves clean strings unchanged
 * - updateRound: creates/upserts round rows
 * - getTierStats: counts actors per tier
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SQLiteGraphStore } from "../src/db.js";
import type { ActorRow } from "../src/db.js";
import {
  logAction,
  sanitizeDetail,
  updateRound,
  getTierStats,
} from "../src/telemetry.js";

let store: SQLiteGraphStore;

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

beforeEach(() => {
  store = new SQLiteGraphStore(":memory:");
  store.createRun({
    id: "run-1",
    started_at: new Date().toISOString(),
    seed: 42,
    config_snapshot: "{}",
    graph_revision_id: "rev-1",
    status: "running",
  });
});

afterEach(() => {
  store.close();
});

// ═══════════════════════════════════════════════════════
// logAction
// ═══════════════════════════════════════════════════════

describe("logAction", () => {
  it("inserts telemetry row", () => {
    const actor = makeActor();
    store.addActor(actor);

    logAction(store, "run-1", 3, "actor-1", "B", "post", '{"content":"hello"}');

    const rows = (store as any).db
      .prepare("SELECT * FROM telemetry WHERE run_id = ?")
      .all("run-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe("actor-1");
    expect(rows[0].cognition_tier).toBe("B");
    expect(rows[0].action_type).toBe("post");
    expect(rows[0].round_num).toBe(3);
  });

  it("stores llmStats when provided", () => {
    logAction(store, "run-1", 1, undefined, "A", "post", undefined, {
      tokensInput: 500,
      tokensOutput: 100,
      costUsd: 0.003,
      durationMs: 1200,
      provider: "anthropic",
    });

    const rows = (store as any).db
      .prepare("SELECT * FROM telemetry WHERE run_id = ?")
      .all("run-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].tokens_input).toBe(500);
    expect(rows[0].tokens_output).toBe(100);
    expect(rows[0].cost_usd).toBeCloseTo(0.003);
    expect(rows[0].duration_ms).toBe(1200);
    expect(rows[0].provider).toBe("anthropic");
  });

  it("stores NULLs for optional fields when omitted", () => {
    logAction(store, "run-1", 1, undefined, undefined, "idle");

    const rows = (store as any).db
      .prepare("SELECT * FROM telemetry WHERE run_id = ?")
      .all("run-1");
    expect(rows[0].actor_id).toBeNull();
    expect(rows[0].cognition_tier).toBeNull();
    expect(rows[0].action_detail).toBeNull();
    expect(rows[0].tokens_input).toBeNull();
  });

  it("sanitizes detail containing API key before storage", () => {
    const detail = '{"apiKey":"sk-ant-1234567890abcdefghij","action":"post"}';
    logAction(store, "run-1", 1, undefined, undefined, "post", detail);

    const rows = (store as any).db
      .prepare("SELECT action_detail FROM telemetry WHERE run_id = ?")
      .all("run-1");
    expect(rows[0].action_detail).not.toContain("sk-ant-1234567890");
    expect(rows[0].action_detail).toContain("[REDACTED]");
    expect(rows[0].action_detail).toContain("action");
  });
});

// ═══════════════════════════════════════════════════════
// sanitizeDetail
// ═══════════════════════════════════════════════════════

describe("sanitizeDetail", () => {
  it("redacts sk- API keys", () => {
    const input = 'Using key sk-ant-abcdefghijklmnopqrstuvwx for auth';
    const result = sanitizeDetail(input);
    expect(result).not.toContain("sk-ant-abcdefghijklmnopqrstuvwx");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts key- prefixed tokens", () => {
    const input = 'Token is key-abcdefghijklmnopqrstuvwxyz';
    const result = sanitizeDetail(input);
    expect(result).not.toContain("key-abcdefghijklmnopqrstuvwxyz");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts Bearer tokens", () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload';
    const result = sanitizeDetail(input);
    expect(result).toContain("Bearer [REDACTED]");
    expect(result).not.toContain("eyJhbG");
  });

  it("redacts JSON keys matching sensitive patterns", () => {
    const input = '{"token":"mytoken123","name":"safe","api_key":"secret-value"}';
    const result = sanitizeDetail(input);
    expect(result).toContain('"token":"[REDACTED]"');
    expect(result).toContain('"api_key":"[REDACTED]"');
    expect(result).toContain('"name":"safe"');
  });

  it("leaves clean strings unchanged", () => {
    const input = '{"action":"post","content":"the key to success"}';
    const result = sanitizeDetail(input);
    expect(result).toBe(input);
  });

  it("handles multiple sensitive fields in one string", () => {
    const input = '{"password":"abc123","secret":"xyz789","data":"ok"}';
    const result = sanitizeDetail(input);
    expect(result).toContain('"password":"[REDACTED]"');
    expect(result).toContain('"secret":"[REDACTED]"');
    expect(result).toContain('"data":"ok"');
  });
});

// ═══════════════════════════════════════════════════════
// updateRound
// ═══════════════════════════════════════════════════════

describe("updateRound", () => {
  it("creates a round row", () => {
    updateRound(store, {
      num: 1,
      runId: "run-1",
      simTime: "2024-01-01T09:00:00",
      activeActors: 15,
      totalPosts: 8,
      totalActions: 20,
      tierACalls: 3,
      tierBCalls: 5,
      tierCActions: 12,
      avgSentiment: -0.3,
      trendingTopics: ["education", "protest"],
      wallTimeMs: 1500,
    });

    const rows = (store as any).db
      .prepare("SELECT * FROM rounds WHERE run_id = ? AND num = ?")
      .all("run-1", 1);
    expect(rows).toHaveLength(1);
    expect(rows[0].active_actors).toBe(15);
    expect(rows[0].total_posts).toBe(8);
    expect(rows[0].tier_a_calls).toBe(3);
    expect(rows[0].tier_b_calls).toBe(5);
    expect(rows[0].tier_c_actions).toBe(12);
    expect(JSON.parse(rows[0].trending_topics)).toEqual(["education", "protest"]);
  });

  it("upserts existing round row", () => {
    updateRound(store, { num: 1, runId: "run-1", totalPosts: 5 });
    updateRound(store, { num: 1, runId: "run-1", totalPosts: 10, activeActors: 20 });

    const rows = (store as any).db
      .prepare("SELECT * FROM rounds WHERE run_id = ? AND num = ?")
      .all("run-1", 1);
    expect(rows).toHaveLength(1);
    expect(rows[0].total_posts).toBe(10);
    expect(rows[0].active_actors).toBe(20);
  });
});

// ═══════════════════════════════════════════════════════
// getTierStats
// ═══════════════════════════════════════════════════════

describe("getTierStats", () => {
  it("counts actors per cognition tier", () => {
    store.addActor(makeActor({ id: "a1", cognition_tier: "A" }));
    store.addActor(makeActor({ id: "a2", cognition_tier: "A" }));
    store.addActor(makeActor({ id: "a3", cognition_tier: "B" }));
    store.addActor(makeActor({ id: "a4", cognition_tier: "C" }));
    store.addActor(makeActor({ id: "a5", cognition_tier: "C" }));
    store.addActor(makeActor({ id: "a6", cognition_tier: "C" }));

    const stats = getTierStats(store, "run-1");
    expect(stats.tierA).toBe(2);
    expect(stats.tierB).toBe(1);
    expect(stats.tierC).toBe(3);
  });

  it("returns zeros when no actors exist", () => {
    const stats = getTierStats(store, "run-1");
    expect(stats).toEqual({ tierA: 0, tierB: 0, tierC: 0 });
  });
});
