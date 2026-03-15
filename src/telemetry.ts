/**
 * telemetry.ts — Structured event logging to SQLite
 *
 * Source of truth: PLAN.md §Telemetry table, CLAUDE.md Phase 4.3
 *
 * Provides:
 * - logAction(): insert telemetry row with sanitized detail
 * - sanitizeDetail(): redact API keys/tokens from JSON strings
 * - updateRound(): upsert round-level aggregate stats
 * - getTierStats(): count actors per cognition tier
 */

import type { GraphStore, SimEvent } from "./db.js";
import type { CognitionTier } from "./cognition.js";

// ═══════════════════════════════════════════════════════
// LOG ACTION — insert telemetry row
// ═══════════════════════════════════════════════════════

export interface LLMStats {
  tokensInput?: number;
  tokensOutput?: number;
  costUsd?: number;
  durationMs?: number;
  provider?: string;
}

/**
 * Log a simulation action to the telemetry table.
 * Sanitizes action_detail before storage.
 */
export function logAction(
  store: GraphStore,
  runId: string,
  roundNum: number,
  actorId: string | undefined,
  tier: CognitionTier | undefined,
  actionType: string,
  detail?: string,
  llmStats?: LLMStats
): void {
  store.logTelemetry({
    run_id: runId,
    round_num: roundNum,
    actor_id: actorId,
    cognition_tier: tier,
    action_type: actionType,
    action_detail: detail ? sanitizeDetail(detail) : undefined,
    tokens_input: llmStats?.tokensInput,
    tokens_output: llmStats?.tokensOutput,
    cost_usd: llmStats?.costUsd,
    duration_ms: llmStats?.durationMs,
    provider: llmStats?.provider,
  });
}

// ═══════════════════════════════════════════════════════
// SANITIZE DETAIL — redact secrets from action_detail
// ═══════════════════════════════════════════════════════

/**
 * Redact API keys, tokens, and secrets from a detail string.
 * Targets JSON key-value patterns and known secret prefixes.
 */
export function sanitizeDetail(detail: string): string {
  let sanitized = detail;

  // 1. Redact values for known sensitive JSON keys
  sanitized = sanitized.replace(
    /"(api[_-]?key|token|secret|password|bearer|authorization|credentials?)"\s*:\s*"[^"]*"/gi,
    (_, key: string) => `"${key}":"[REDACTED]"`
  );

  // 2. Redact inline API key patterns (sk-..., key-...)
  sanitized = sanitized.replace(/\bsk-[a-zA-Z0-9_-]{20,}\b/g, "[REDACTED]");
  sanitized = sanitized.replace(/\bkey-[a-zA-Z0-9_-]{20,}\b/g, "[REDACTED]");

  // 3. Redact Bearer tokens
  sanitized = sanitized.replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, "Bearer [REDACTED]");

  return sanitized;
}

// ═══════════════════════════════════════════════════════
// UPDATE ROUND — upsert round-level aggregates
// ═══════════════════════════════════════════════════════

export interface RoundData {
  num: number;
  runId: string;
  simTime?: string;
  activeActors?: number;
  totalPosts?: number;
  totalActions?: number;
  tierACalls?: number;
  tierBCalls?: number;
  tierCActions?: number;
  avgSentiment?: number;
  trendingTopics?: string[];
  events?: SimEvent[];
  wallTimeMs?: number;
}

/**
 * Update round-level aggregate statistics.
 * Serializes arrays to JSON for storage.
 */
export function updateRound(store: GraphStore, roundData: RoundData): void {
  store.upsertRound({
    num: roundData.num,
    run_id: roundData.runId,
    sim_time: roundData.simTime,
    active_actors: roundData.activeActors,
    total_posts: roundData.totalPosts,
    total_actions: roundData.totalActions,
    tier_a_calls: roundData.tierACalls,
    tier_b_calls: roundData.tierBCalls,
    tier_c_actions: roundData.tierCActions,
    avg_sentiment: roundData.avgSentiment,
    trending_topics: roundData.trendingTopics
      ? JSON.stringify(roundData.trendingTopics)
      : undefined,
    events: roundData.events ? JSON.stringify(roundData.events) : undefined,
    wall_time_ms: roundData.wallTimeMs,
  });
}

// ═══════════════════════════════════════════════════════
// TIER STATS — count actors per cognition tier
// ═══════════════════════════════════════════════════════

export interface TierStats {
  tierA: number;
  tierB: number;
  tierC: number;
}

/**
 * Count actors per cognition tier for a run.
 */
export function getTierStats(
  store: GraphStore,
  runId: string
): TierStats {
  const actors = store.getActorsByRun(runId);
  let tierA = 0;
  let tierB = 0;
  let tierC = 0;
  for (const a of actors) {
    if (a.cognition_tier === "A") tierA++;
    else if (a.cognition_tier === "B") tierB++;
    else tierC++;
  }
  return { tierA, tierB, tierC };
}
