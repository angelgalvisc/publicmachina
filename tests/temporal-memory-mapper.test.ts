/**
 * temporal-memory-mapper.test.ts — Tests for episode derivation + outbox flush
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { deriveTemporalEpisodes, flushOutboxToProvider } from "../src/temporal-memory-mapper.js";
import { NoopTemporalMemoryProvider } from "../src/temporal-memory.js";
import type { ScheduledActorAction } from "../src/scheduler.js";
import type { NarrativeRow, SimEvent, TemporalMemoryOutboxRow } from "../src/types.js";
import type { GraphStore } from "../src/store.js";

// ═══════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════

function makeAction(overrides: Partial<ScheduledActorAction> = {}): ScheduledActorAction {
  return {
    index: 0,
    actor: {
      id: "actor-1",
      run_id: "run-1",
      entity_id: null,
      archetype: "persona",
      cognition_tier: "A",
      name: "Test Actor",
      handle: "testactor",
      personality: "analytical",
      bio: "Test bio",
      stance: "neutral",
      sentiment_bias: 0,
      activity_level: 0.5,
      influence_weight: 0.8,
      community_id: "comm-1",
      follower_count: 100,
      following_count: 50,
    } as any,
    actorTopics: ["crypto", "markets"],
    feed: [],
    route: { tier: "A", reason: "high influence" },
    decision: { action: "post", content: "Bitcoin is looking strong today", reasoning: "Market signals are bullish" },
    searchRequests: [],
    searchEligible: false,
    searchSelected: false,
    searchQueries: [],
    ...overrides,
  };
}

function makeMockStore(): GraphStore {
  const outbox: TemporalMemoryOutboxRow[] = [];
  return {
    insertOutboxEpisode: vi.fn((row: TemporalMemoryOutboxRow) => {
      outbox.push(row);
    }),
    getPendingOutboxEpisodes: vi.fn((_runId: string, _roundNum: number) => {
      return outbox.filter((r) => r.synced_at === null);
    }),
    markOutboxSynced: vi.fn((ids: string[]) => {
      for (const row of outbox) {
        if (ids.includes(row.id)) row.synced_at = new Date().toISOString();
      }
    }),
    markOutboxError: vi.fn((ids: string[], error: string) => {
      for (const row of outbox) {
        if (ids.includes(row.id)) row.sync_error = error;
      }
    }),
    upsertSyncState: vi.fn(),
  } as unknown as GraphStore;
}

// ═══════════════════════════════════════════════════════
// DERIVE EPISODES
// ═══════════════════════════════════════════════════════

describe("deriveTemporalEpisodes", () => {
  let store: GraphStore;

  beforeEach(() => {
    store = makeMockStore();
  });

  it("generates post_created + opinion_expressed for a post action", () => {
    const actions = [makeAction()];
    const count = deriveTemporalEpisodes(store, "run-1", 0, actions, [], []);
    expect(count).toBe(2); // post_created + opinion_expressed
    expect(store.insertOutboxEpisode).toHaveBeenCalledTimes(2);

    const calls = (store.insertOutboxEpisode as any).mock.calls;
    const types = calls.map((c: any) => c[0].episode_type);
    expect(types).toContain("post_created");
    expect(types).toContain("opinion_expressed");
  });

  it("generates follow_changed for follow action", () => {
    const actions = [
      makeAction({
        decision: { action: "follow", target: "actor-2", reasoning: "interesting content" },
      }),
    ];
    const count = deriveTemporalEpisodes(store, "run-1", 0, actions, [], []);
    expect(count).toBe(1);

    const call = (store.insertOutboxEpisode as any).mock.calls[0][0];
    expect(call.episode_type).toBe("follow_changed");
    const payload = JSON.parse(call.payload_json);
    expect(payload.target_actor_id).toBe("actor-2");
  });

  it("generates block_changed for block action", () => {
    const actions = [
      makeAction({
        decision: { action: "block", target: "actor-3", reasoning: "toxic behavior" },
      }),
    ];
    const count = deriveTemporalEpisodes(store, "run-1", 0, actions, [], []);
    expect(count).toBe(1);
    const call = (store.insertOutboxEpisode as any).mock.calls[0][0];
    expect(call.episode_type).toBe("block_changed");
  });

  it("generates comment_created + opinion_expressed for comment action", () => {
    const actions = [
      makeAction({
        decision: { action: "comment", target: "post-1", content: "Interesting take", reasoning: "wanted to engage" },
      }),
    ];
    const count = deriveTemporalEpisodes(store, "run-1", 0, actions, [], []);
    expect(count).toBe(2); // comment_created + opinion_expressed
    const calls = (store.insertOutboxEpisode as any).mock.calls;
    expect(calls[0][0].episode_type).toBe("comment_created");
    expect(calls[1][0].episode_type).toBe("opinion_expressed");
  });

  it("generates repost_created for repost action", () => {
    const actions = [
      makeAction({
        decision: { action: "repost", target: "post-2", reasoning: "worth amplifying" },
      }),
    ];
    const count = deriveTemporalEpisodes(store, "run-1", 0, actions, [], []);
    expect(count).toBe(1);
    const call = (store.insertOutboxEpisode as any).mock.calls[0][0];
    expect(call.episode_type).toBe("repost_created");
  });

  it("skips Tier C actions", () => {
    const actions = [
      makeAction({ route: { tier: "C", reason: "default" } }),
    ];
    const count = deriveTemporalEpisodes(store, "run-1", 0, actions, [], []);
    expect(count).toBe(0);
    expect(store.insertOutboxEpisode).not.toHaveBeenCalled();
  });

  it("generates event_observed when actor topics match event", () => {
    const actions = [makeAction({ decision: { action: "idle" } })];
    const events: SimEvent[] = [
      {
        type: "scheduled",
        round: 0,
        content: "SEC announces new crypto regulation",
        topics: ["crypto", "regulation"],
      },
    ];
    const count = deriveTemporalEpisodes(store, "run-1", 0, actions, events, []);
    // event_observed for the actor (topics overlap)
    expect(count).toBeGreaterThanOrEqual(1);
    const calls = (store.insertOutboxEpisode as any).mock.calls;
    const types = calls.map((c: any) => c[0].episode_type);
    expect(types).toContain("event_observed");
  });

  it("generates narrative_shift for active narratives", () => {
    const narratives: NarrativeRow[] = [
      {
        id: "n-1",
        run_id: "run-1",
        topic: "crypto",
        first_round: 0,
        peak_round: 3,
        current_intensity: 0.8,
        total_posts: 15,
        dominant_sentiment: 0.3,
      },
    ];
    const count = deriveTemporalEpisodes(store, "run-1", 3, [], [], narratives);
    expect(count).toBe(1);
    const call = (store.insertOutboxEpisode as any).mock.calls[0][0];
    expect(call.episode_type).toBe("narrative_shift");
  });

  it("does not generate narrative_shift for extinct narratives", () => {
    const narratives: NarrativeRow[] = [
      {
        id: "n-2",
        run_id: "run-1",
        topic: "old-topic",
        first_round: 0,
        peak_round: 1,
        current_intensity: 0.05,
        total_posts: 2,
        dominant_sentiment: 0,
      },
    ];
    const count = deriveTemporalEpisodes(store, "run-1", 5, [], [], narratives);
    expect(count).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════
// FLUSH OUTBOX
// ═══════════════════════════════════════════════════════

describe("flushOutboxToProvider", () => {
  it("marks episodes as synced on successful flush", async () => {
    const store = makeMockStore();
    // Pre-populate outbox
    deriveTemporalEpisodes(
      store,
      "run-1",
      0,
      [makeAction()],
      [],
      []
    );

    const provider = new NoopTemporalMemoryProvider();
    const result = await flushOutboxToProvider(store, "run-1", 0, provider);

    expect(result.synced).toBe(2); // post_created + opinion_expressed
    expect(result.failed).toBe(0);
    expect(store.markOutboxSynced).toHaveBeenCalled();
    expect(store.upsertSyncState).toHaveBeenCalledWith("run-1", 0);
  });

  it("marks episodes as errored after all retries fail", async () => {
    const store = makeMockStore();
    deriveTemporalEpisodes(store, "run-1", 0, [makeAction()], [], []);

    // Provider that always fails
    const failProvider: any = {
      appendEpisodes: vi.fn().mockRejectedValue(new Error("connection refused")),
      healthCheck: vi.fn().mockResolvedValue(false),
      queryActorContext: vi.fn(),
      queryNarrativeContext: vi.fn(),
      queryRelationshipContext: vi.fn(),
    };

    const result = await flushOutboxToProvider(store, "run-1", 0, failProvider);

    expect(result.synced).toBe(0);
    expect(result.failed).toBe(2);
    expect(store.markOutboxError).toHaveBeenCalled();
    expect(failProvider.appendEpisodes).toHaveBeenCalledTimes(3); // 3 retries
  }, 10000);

  it("returns zeros when outbox is empty", async () => {
    const store = makeMockStore();
    const provider = new NoopTemporalMemoryProvider();
    const result = await flushOutboxToProvider(store, "run-1", 0, provider);
    expect(result.synced).toBe(0);
    expect(result.failed).toBe(0);
  });
});
