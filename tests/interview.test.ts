/**
 * interview.test.ts — Tests for actor interview module
 *
 * Covers:
 * - formatActorContext: name/personality/stance, beliefs, empty data
 * - resolveActorByName: exact name, handle, partial, ambiguous, not found
 * - interviewActor: successful interview, missing actor
 * - Multi-turn interview: session creation, history accumulation
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SQLiteGraphStore } from "../src/db.js";
import { MockCognitionBackend } from "../src/cognition.js";
import {
  formatActorContext,
  resolveActorByName,
  interviewActor,
  createInterviewSession,
  continueInterview,
} from "../src/interview.js";

// ═══════════════════════════════════════════════════════
// TEST HELPER
// ═══════════════════════════════════════════════════════

function setupInterviewStore(): { store: SQLiteGraphStore; runId: string; actorId: string } {
  const store = new SQLiteGraphStore(":memory:");
  const runId = "interview-run";
  store.createRun({
    id: runId,
    started_at: new Date().toISOString(),
    seed: 42,
    config_snapshot: "{}",
    graph_revision_id: "test",
    status: "completed",
    total_rounds: 10,
  });

  const actorId = "journalist-01";
  store.addActor({
    id: actorId,
    run_id: runId,
    entity_id: null,
    archetype: "media",
    cognition_tier: "A",
    name: "Sarah Chen",
    handle: "sarahchen",
    personality: "An investigative journalist focused on institutional accountability. Values evidence-based reporting.",
    bio: "Senior reporter at the Daily Herald",
    age: 35,
    gender: "female",
    profession: "journalist",
    region: "Northeast",
    language: "en",
    stance: "critical",
    sentiment_bias: -0.2,
    activity_level: 0.8,
    influence_weight: 0.7,
    community_id: null,
    active_hours: JSON.stringify([8, 9, 10, 14, 15, 16, 17]),
    follower_count: 500,
    following_count: 200,
  });

  // Add a second actor for resolution tests
  store.addActor({
    id: "activist-01",
    run_id: runId,
    entity_id: null,
    archetype: "persona",
    cognition_tier: "B",
    name: "Sarah Martinez",
    handle: "smartinez",
    personality: "Student activist passionate about climate justice.",
    bio: null,
    age: 22,
    gender: "female",
    profession: "student",
    region: "Southwest",
    language: "en",
    stance: "opposed",
    sentiment_bias: -0.5,
    activity_level: 0.9,
    influence_weight: 0.4,
    community_id: null,
    active_hours: null,
    follower_count: 300,
    following_count: 150,
  });

  store.addActorBelief(actorId, "tuition", -0.7);
  store.addActorBelief(actorId, "transparency", 0.9);
  store.addActorTopic(actorId, "tuition", 0.9);
  store.addActorTopic(actorId, "transparency", 0.7);

  // Add a recent post
  store.addPost({
    id: "post-j1",
    run_id: runId,
    author_id: actorId,
    content: "Breaking: University board approves 15% tuition increase despite student protests",
    round_num: 5,
    sim_timestamp: "2024-01-01T05:00:00",
    likes: 45,
    reposts: 12,
    comments: 8,
    reach: 500,
    sentiment: -0.6,
  });

  return { store, runId, actorId };
}

// ═══════════════════════════════════════════════════════
// formatActorContext
// ═══════════════════════════════════════════════════════

describe("formatActorContext", () => {
  let store: SQLiteGraphStore;
  let runId: string;
  let actorId: string;

  beforeEach(() => {
    ({ store, runId, actorId } = setupInterviewStore());
  });

  afterEach(() => {
    store.close();
  });

  it("includes name, personality, and stance", () => {
    const context = store.queryActorContext(actorId, runId);
    const output = formatActorContext(context);

    expect(output).toContain("Sarah Chen");
    expect(output).toContain("investigative journalist");
    expect(output).toContain("critical");
  });

  it("includes beliefs with sentiment values", () => {
    const context = store.queryActorContext(actorId, runId);
    const output = formatActorContext(context);

    expect(output).toContain("tuition");
    expect(output).toContain("-0.70");
    expect(output).toContain("transparency");
    expect(output).toContain("+0.90");
  });

  it("handles empty beliefs and topics", () => {
    // Use the second actor which has no beliefs or topics
    const context = store.queryActorContext("activist-01", runId);
    const output = formatActorContext(context);

    // Should not crash, should still contain actor info
    expect(output).toContain("Sarah Martinez");
    expect(output).toContain("opposed");
    // Should not contain beliefs or topics headers
    expect(output).not.toContain("Beliefs:");
    expect(output).not.toContain("Topics:");
  });
});

// ═══════════════════════════════════════════════════════
// resolveActorByName
// ═══════════════════════════════════════════════════════

describe("resolveActorByName", () => {
  let store: SQLiteGraphStore;
  let runId: string;

  beforeEach(() => {
    ({ store, runId } = setupInterviewStore());
  });

  afterEach(() => {
    store.close();
  });

  it("resolves by exact name (case-insensitive)", () => {
    const actor = resolveActorByName(store, runId, "sarah chen");
    expect(actor.id).toBe("journalist-01");
    expect(actor.name).toBe("Sarah Chen");
  });

  it("resolves by handle", () => {
    const actor1 = resolveActorByName(store, runId, "sarahchen");
    expect(actor1.id).toBe("journalist-01");

    const actor2 = resolveActorByName(store, runId, "@sarahchen");
    expect(actor2.id).toBe("journalist-01");
  });

  it("resolves by partial name when unambiguous", () => {
    const actor = resolveActorByName(store, runId, "Chen");
    expect(actor.id).toBe("journalist-01");
  });

  it("throws on ambiguous partial match", () => {
    expect(() => resolveActorByName(store, runId, "Sarah")).toThrow("Ambiguous");
    expect(() => resolveActorByName(store, runId, "Sarah")).toThrow("Sarah Chen");
    expect(() => resolveActorByName(store, runId, "Sarah")).toThrow("Sarah Martinez");
  });

  it("throws with available names on no match", () => {
    expect(() => resolveActorByName(store, runId, "nonexistent")).toThrow("Actor not found");
    expect(() => resolveActorByName(store, runId, "nonexistent")).toThrow("Available:");
  });
});

// ═══════════════════════════════════════════════════════
// interviewActor
// ═══════════════════════════════════════════════════════

describe("interviewActor", () => {
  let store: SQLiteGraphStore;
  let runId: string;
  let actorId: string;

  beforeEach(() => {
    ({ store, runId, actorId } = setupInterviewStore());
  });

  afterEach(() => {
    store.close();
  });

  it("returns interview result with mock backend", async () => {
    const backend = new MockCognitionBackend();
    const result = await interviewActor(store, runId, actorId, backend, "What do you think about tuition?");

    expect(result.actorId).toBe(actorId);
    expect(result.actorName).toBe("Sarah Chen");
    expect(result.question).toBe("What do you think about tuition?");
    expect(result.response).toContain("Mock interview response");

    // Verify the backend received the context and question
    expect(backend.interviewCalls).toHaveLength(1);
    expect(backend.interviewCalls[0].question).toBe("What do you think about tuition?");
    expect(backend.interviewCalls[0].context).toContain("Sarah Chen");
  });

  it("throws on missing actor", async () => {
    const backend = new MockCognitionBackend();
    await expect(
      interviewActor(store, runId, "nonexistent-id", backend, "Hello?")
    ).rejects.toThrow("Actor not found");
  });
});

// ═══════════════════════════════════════════════════════
// Multi-turn interview
// ═══════════════════════════════════════════════════════

describe("multi-turn interview", () => {
  let store: SQLiteGraphStore;
  let runId: string;
  let actorId: string;

  beforeEach(() => {
    ({ store, runId, actorId } = setupInterviewStore());
  });

  afterEach(() => {
    store.close();
  });

  it("createInterviewSession returns session with empty history", () => {
    const session = createInterviewSession(store, runId, actorId);

    expect(session.actorId).toBe(actorId);
    expect(session.actorName).toBe("Sarah Chen");
    expect(session.history).toEqual([]);
  });

  it("continueInterview maintains history across turns", async () => {
    const backend = new MockCognitionBackend();
    const session = createInterviewSession(store, runId, actorId);

    // First turn
    const response1 = await continueInterview(session, store, runId, backend, "What is your stance on tuition?");
    expect(response1).toContain("Mock interview response");
    expect(session.history).toHaveLength(2);
    expect(session.history[0]).toEqual({ role: "user", content: "What is your stance on tuition?" });
    expect(session.history[1].role).toBe("assistant");

    // Second turn — backend should receive context that includes previous conversation
    const response2 = await continueInterview(session, store, runId, backend, "Can you elaborate?");
    expect(response2).toContain("Mock interview response");
    expect(session.history).toHaveLength(4);
    expect(session.history[2]).toEqual({ role: "user", content: "Can you elaborate?" });
    expect(session.history[3].role).toBe("assistant");

    // Verify the second call included conversation history in context
    expect(backend.interviewCalls).toHaveLength(2);
    expect(backend.interviewCalls[1].context).toContain("Previous conversation:");
    expect(backend.interviewCalls[1].context).toContain("Researcher:");
    expect(backend.interviewCalls[1].context).toContain("Sarah Chen:");
  });
});
