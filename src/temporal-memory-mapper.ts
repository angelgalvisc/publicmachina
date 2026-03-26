/**
 * temporal-memory-mapper.ts — Derive temporal episodes from round actions
 *
 * Two responsibilities:
 *   1. deriveTemporalEpisodes() — maps ScheduledActorActions → outbox rows
 *   2. flushOutboxToProvider() — reads pending outbox, sends to provider, marks synced
 *
 * Import hygiene: imports from src/types.ts, NOT src/db.ts barrel.
 * Reference: PLAN_PRODUCT_EVOLUTION.md §4.5, §4.6
 */

import type {
  TemporalEpisode,
  TemporalEpisodeType,
  TemporalMemoryOutboxRow,
  NarrativeRow,
  SimEvent,
} from "./types.js";
import type { GraphStore } from "./store.js";
import type { ScheduledActorAction } from "./scheduler.js";
import type { TemporalMemoryProvider } from "./temporal-memory.js";
import { randomUUID } from "node:crypto";

// ═══════════════════════════════════════════════════════
// DERIVE EPISODES → OUTBOX
// ═══════════════════════════════════════════════════════

/**
 * Derive temporal episodes from the round's scheduled actions and write
 * them to the outbox table. Called inside the engine's per-round transaction.
 *
 * This is intentionally SEPARATE from persistActorMemories().
 * Flat SQLite memories and temporal episodes serve different purposes:
 *   - Flat memories: fast lookup for prompt context (salience-sorted)
 *   - Temporal episodes: rich relational history with validity windows
 */
export function deriveTemporalEpisodes(
  store: GraphStore,
  runId: string,
  roundNum: number,
  actions: ScheduledActorAction[],
  activeEvents: SimEvent[],
  narratives: NarrativeRow[]
): number {
  const now = new Date().toISOString();
  let count = 0;

  for (const action of actions) {
    // Skip Tier C — they don't generate meaningful episodes
    if (action.route.tier === "C") continue;

    const episodes = mapActionToEpisodes(runId, roundNum, action, now);
    for (const episode of episodes) {
      const row: TemporalMemoryOutboxRow = {
        id: episode.id,
        run_id: runId,
        round_num: roundNum,
        episode_type: episode.episode_type,
        payload_json: JSON.stringify(episode),
        created_at: now,
        synced_at: null,
        sync_error: null,
      };
      store.insertOutboxEpisode(row);
      count++;
    }
  }

  // Event-observed episodes (for actors whose topics match)
  for (const event of activeEvents) {
    for (const action of actions) {
      if (action.route.tier === "C") continue;
      const topicSet = new Set(action.actorTopics);
      if (!event.topics.some((t) => topicSet.has(t))) continue;

      const episode: TemporalEpisode = {
        id: randomUUID(),
        run_id: runId,
        round_num: roundNum,
        episode_type: "event_observed",
        actor_id: action.actor.id,
        topic: event.topics[0],
        content: `Observed ${event.type}: ${truncate(event.content, 200)}`,
        metadata: { eventType: event.type, topics: event.topics },
        created_at: new Date().toISOString(),
      };
      store.insertOutboxEpisode({
        id: episode.id,
        run_id: runId,
        round_num: roundNum,
        episode_type: "event_observed",
        payload_json: JSON.stringify(episode),
        created_at: new Date().toISOString(),
        synced_at: null,
        sync_error: null,
      });
      count++;
    }
  }

  // Narrative shifts (when intensity changes significantly)
  for (const narrative of narratives) {
    if (narrative.current_intensity < 0.1) continue;
    const peakDelta =
      narrative.peak_round === roundNum ? "peaked this round" : "ongoing";

    const episode: TemporalEpisode = {
      id: randomUUID(),
      run_id: runId,
      round_num: roundNum,
      episode_type: "narrative_shift",
      actor_id: "system",
      topic: narrative.topic,
      content: `Narrative "${narrative.topic}" intensity=${narrative.current_intensity.toFixed(2)}, sentiment=${narrative.dominant_sentiment.toFixed(2)}, ${peakDelta}`,
      metadata: {
        intensity: narrative.current_intensity,
        sentiment: narrative.dominant_sentiment,
        peakRound: narrative.peak_round,
      },
      created_at: new Date().toISOString(),
    };
    store.insertOutboxEpisode({
      id: episode.id,
      run_id: runId,
      round_num: roundNum,
      episode_type: "narrative_shift",
      payload_json: JSON.stringify(episode),
      created_at: new Date().toISOString(),
      synced_at: null,
      sync_error: null,
    });
    count++;
  }

  return count;
}

// ═══════════════════════════════════════════════════════
// MAP SINGLE ACTION → EPISODES
// ═══════════════════════════════════════════════════════

function mapActionToEpisodes(
  runId: string,
  roundNum: number,
  action: ScheduledActorAction,
  timestamp: string
): TemporalEpisode[] {
  const episodes: TemporalEpisode[] = [];
  const d = action.decision;
  const actorId = action.actor.id;
  const actorName = action.actor.name;

  switch (d.action) {
    case "post":
      episodes.push({
        id: randomUUID(),
        run_id: runId,
        round_num: roundNum,
        episode_type: "post_created",
        actor_id: actorId,
        actor_name: actorName,
        content: truncate(d.content ?? "", 300),
        topic: action.actorTopics[0],
        metadata: { reasoning: d.reasoning },
        created_at: timestamp,
      });
      // If the post expresses a stance, also record opinion_expressed
      if (d.content && d.reasoning) {
        episodes.push({
          id: randomUUID(),
          run_id: runId,
          round_num: roundNum,
          episode_type: "opinion_expressed",
          actor_id: actorId,
          actor_name: actorName,
          content: `Expressed opinion via post: ${truncate(d.content, 150)}`,
          topic: action.actorTopics[0],
          metadata: { reasoning: d.reasoning, via: "post" },
          created_at: timestamp,
        });
      }
      break;

    case "comment":
      episodes.push({
        id: randomUUID(),
        run_id: runId,
        round_num: roundNum,
        episode_type: "comment_created",
        actor_id: actorId,
        actor_name: actorName,
        target_actor_id: d.target,
        content: truncate(d.content ?? "", 300),
        topic: action.actorTopics[0],
        metadata: { reasoning: d.reasoning, targetPost: d.target },
        created_at: timestamp,
      });
      // Comments expressing opinions also generate opinion_expressed
      if (d.content && d.reasoning) {
        episodes.push({
          id: randomUUID(),
          run_id: runId,
          round_num: roundNum,
          episode_type: "opinion_expressed",
          actor_id: actorId,
          actor_name: actorName,
          target_actor_id: d.target,
          content: `Expressed opinion via comment: ${truncate(d.content, 150)}`,
          topic: action.actorTopics[0],
          metadata: { reasoning: d.reasoning, via: "comment" },
          created_at: timestamp,
        });
      }
      break;

    case "repost":
      episodes.push({
        id: randomUUID(),
        run_id: runId,
        round_num: roundNum,
        episode_type: "repost_created",
        actor_id: actorId,
        actor_name: actorName,
        target_actor_id: d.target,
        content: `Amplified post ${d.target}`,
        topic: action.actorTopics[0],
        metadata: { reasoning: d.reasoning },
        created_at: timestamp,
      });
      break;

    case "follow":
    case "unfollow":
      episodes.push({
        id: randomUUID(),
        run_id: runId,
        round_num: roundNum,
        episode_type: "follow_changed",
        actor_id: actorId,
        actor_name: actorName,
        target_actor_id: d.target,
        content: `${d.action === "follow" ? "Started following" : "Stopped following"} ${d.target}`,
        metadata: { action: d.action, reasoning: d.reasoning },
        created_at: timestamp,
      });
      break;

    case "mute":
      episodes.push({
        id: randomUUID(),
        run_id: runId,
        round_num: roundNum,
        episode_type: "mute_changed",
        actor_id: actorId,
        actor_name: actorName,
        target_actor_id: d.target,
        content: `Muted ${d.target}`,
        metadata: { reasoning: d.reasoning },
        created_at: timestamp,
      });
      break;

    case "block":
      episodes.push({
        id: randomUUID(),
        run_id: runId,
        round_num: roundNum,
        episode_type: "block_changed",
        actor_id: actorId,
        actor_name: actorName,
        target_actor_id: d.target,
        content: `Blocked ${d.target}`,
        metadata: { reasoning: d.reasoning },
        created_at: timestamp,
      });
      break;

    case "quote":
      episodes.push({
        id: randomUUID(),
        run_id: runId,
        round_num: roundNum,
        episode_type: "quote_created",
        actor_id: actorId,
        actor_name: actorName,
        target_actor_id: d.target,
        content: d.content ?? `Quoted post ${d.target}`,
        topic: action.actorTopics[0],
        metadata: { reasoning: d.reasoning },
        created_at: timestamp,
      });
      // Also register the opinion expressed in the quote
      if (d.content) {
        episodes.push({
          id: randomUUID(),
          run_id: runId,
          round_num: roundNum,
          episode_type: "opinion_expressed",
          actor_id: actorId,
          actor_name: actorName,
          content: d.content.slice(0, 280),
          topic: action.actorTopics[0],
          metadata: { via: "quote", target: d.target },
          created_at: timestamp,
        });
      }
      break;

    // idle, like, unlike, delete, report, search — no temporal episode
    default:
      break;
  }

  return episodes;
}

// ═══════════════════════════════════════════════════════
// FLUSH OUTBOX → PROVIDER
// ═══════════════════════════════════════════════════════

const MAX_FLUSH_RETRIES = 3;
const RETRY_DELAY_MS = 500;

/**
 * Read pending outbox rows for this round, send to temporal memory provider,
 * mark as synced or errored. Non-blocking — failures do not stop the simulation.
 */
export async function flushOutboxToProvider(
  store: GraphStore,
  runId: string,
  roundNum: number,
  provider: TemporalMemoryProvider
): Promise<{ synced: number; failed: number }> {
  const pending = store.getPendingOutboxEpisodes(runId, roundNum);
  if (pending.length === 0) {
    return { synced: 0, failed: 0 };
  }

  // Parse episodes from outbox payloads
  const episodes: TemporalEpisode[] = [];
  const ids: string[] = [];
  for (const row of pending) {
    try {
      episodes.push(JSON.parse(row.payload_json) as TemporalEpisode);
      ids.push(row.id);
    } catch {
      // Malformed payload — mark as error immediately
      store.markOutboxError([row.id], "malformed payload_json");
    }
  }

  if (episodes.length === 0) {
    return { synced: 0, failed: pending.length };
  }

  // Attempt to flush with retries
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < MAX_FLUSH_RETRIES; attempt++) {
    try {
      await provider.appendEpisodes(runId, episodes);
      // Success — mark all as synced
      store.markOutboxSynced(ids);
      store.upsertSyncState(runId, roundNum);
      return { synced: episodes.length, failed: 0 };
    } catch (err) {
      lastError = err as Error;
      if (attempt < MAX_FLUSH_RETRIES - 1) {
        await sleep(RETRY_DELAY_MS * Math.pow(2, attempt));
      }
    }
  }

  // All retries exhausted — mark as error
  const errorMsg = lastError?.message ?? "unknown flush error";
  store.markOutboxError(ids, errorMsg);
  store.upsertSyncState(runId, roundNum, errorMsg);
  return { synced: 0, failed: episodes.length };
}

// ═══════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen - 3) + "..." : text;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
