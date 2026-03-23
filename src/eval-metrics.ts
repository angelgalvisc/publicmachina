/**
 * eval-metrics.ts — Evaluation metric extraction from completed runs
 *
 * Computes the quality, runtime, and output-utility metrics defined
 * in evals/metrics.yaml. Operates on a completed run's SQLite database.
 *
 * Reference: PLAN_PRODUCT_EVOLUTION.md §5.4, IMPLEMENTATION_CHECKLIST.md Phase 0
 */

import type {
  ActorRow,
  ActorMemoryRow,
  ActorBeliefRow,
  Post,
  DecisionTraceRow,
} from "./types.js";

// ═══════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════

export interface EvalQualityMetrics {
  contradictionRate: number;
  stanceContinuity: number;
  relationContinuity: number;
  repetitionRate: number;
}

export interface EvalRuntimeMetrics {
  avgWallTimePerRoundMs: number;
  totalTokens: number;
  totalCostUsd: number;
  totalSearchRequests: number;
  roundCount: number;
}

export interface EvalMetricsSnapshot {
  runId: string;
  scenario: string;
  version: string;
  capturedAt: string;
  config: {
    memoryProvider: string;
    feedAlgorithm: string;
    graphitiEnabled: boolean;
    twhinEnabled: boolean;
  };
  quality: EvalQualityMetrics;
  runtime: EvalRuntimeMetrics;
}

// ═══════════════════════════════════════════════════════
// CONTRADICTION RATE
// ═══════════════════════════════════════════════════════

/**
 * Computes the fraction of belief updates that contradict prior stance
 * without an intervening event or new information.
 *
 * A contradiction = belief on topic T flips sign between consecutive
 * rounds for the same actor, with no event touching topic T in between.
 */
export function computeContradictionRate(
  beliefs: ActorBeliefRow[],
  eventRounds: Map<string, Set<number>>
): number {
  if (beliefs.length === 0) return 0;

  // Group beliefs by actor + topic, sorted by round
  const grouped = new Map<string, ActorBeliefRow[]>();
  for (const b of beliefs) {
    const key = `${b.actor_id}|${b.topic}`;
    const list = grouped.get(key) ?? [];
    list.push(b);
    grouped.set(key, list);
  }

  let totalUpdates = 0;
  let contradictions = 0;

  for (const [key, entries] of grouped) {
    if (entries.length < 2) continue;

    const sorted = entries.sort(
      (a, b) => (a.round_updated ?? 0) - (b.round_updated ?? 0)
    );
    const topic = sorted[0].topic;
    const topicEvents = eventRounds.get(topic) ?? new Set();

    for (let i = 1; i < sorted.length; i++) {
      totalUpdates++;
      const prev = sorted[i - 1];
      const curr = sorted[i];

      // Check if sign flipped
      const signFlipped =
        (prev.sentiment >= 0 && curr.sentiment < 0) ||
        (prev.sentiment < 0 && curr.sentiment >= 0);

      if (!signFlipped) continue;

      // Check if there was a relevant event between the two rounds
      const prevRound = prev.round_updated ?? 0;
      const currRound = curr.round_updated ?? 0;
      let eventBetween = false;
      for (let r = prevRound + 1; r <= currRound; r++) {
        if (topicEvents.has(r)) {
          eventBetween = true;
          break;
        }
      }

      if (!eventBetween) {
        contradictions++;
      }
    }
  }

  return totalUpdates > 0 ? contradictions / totalUpdates : 0;
}

// ═══════════════════════════════════════════════════════
// STANCE CONTINUITY
// ═══════════════════════════════════════════════════════

/**
 * Average cosine similarity between consecutive belief state vectors
 * per actor. Higher = more consistent stance evolution.
 */
export function computeStanceContinuity(
  actorBeliefsByRound: Map<string, Map<number, Record<string, number>>>
): number {
  let totalSimilarity = 0;
  let totalPairs = 0;

  for (const [_actorId, roundBeliefs] of actorBeliefsByRound) {
    const rounds = [...roundBeliefs.keys()].sort((a, b) => a - b);
    if (rounds.length < 2) continue;

    for (let i = 1; i < rounds.length; i++) {
      const prev = roundBeliefs.get(rounds[i - 1])!;
      const curr = roundBeliefs.get(rounds[i])!;

      const sim = beliefVectorSimilarity(prev, curr);
      totalSimilarity += sim;
      totalPairs++;
    }
  }

  return totalPairs > 0 ? totalSimilarity / totalPairs : 1.0;
}

/**
 * Cosine similarity between two belief state maps.
 */
function beliefVectorSimilarity(
  a: Record<string, number>,
  b: Record<string, number>
): number {
  const allTopics = new Set([...Object.keys(a), ...Object.keys(b)]);
  if (allTopics.size === 0) return 1.0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (const topic of allTopics) {
    const va = a[topic] ?? 0;
    const vb = b[topic] ?? 0;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ═══════════════════════════════════════════════════════
// RELATION CONTINUITY
// ═══════════════════════════════════════════════════════

/**
 * Measures unjustified follow/unfollow flips. Lower = more stable social graph.
 */
export function computeRelationContinuity(
  followEvents: Array<{
    follower_id: string;
    following_id: string;
    action: "follow" | "unfollow";
    round: number;
  }>
): number {
  if (followEvents.length === 0) return 1.0;

  // Group by pair
  const grouped = new Map<
    string,
    Array<{ action: "follow" | "unfollow"; round: number }>
  >();

  for (const event of followEvents) {
    const key = `${event.follower_id}|${event.following_id}`;
    const list = grouped.get(key) ?? [];
    list.push({ action: event.action, round: event.round });
    grouped.set(key, list);
  }

  let totalEvents = 0;
  let flips = 0;

  for (const [_key, events] of grouped) {
    const sorted = events.sort((a, b) => a.round - b.round);
    for (let i = 1; i < sorted.length; i++) {
      totalEvents++;
      if (sorted[i].action !== sorted[i - 1].action) {
        flips++;
      }
    }
  }

  // Return as continuity score (1 - flip rate)
  return totalEvents > 0 ? 1 - flips / totalEvents : 1.0;
}

// ═══════════════════════════════════════════════════════
// REPETITION RATE
// ═══════════════════════════════════════════════════════

/**
 * Fraction of an actor's posts that are near-duplicates of their own prior posts.
 * Uses simple token overlap as a proxy (no embedding needed for baseline).
 */
export function computeRepetitionRate(
  postsByActor: Map<string, string[]>
): number {
  let totalPairs = 0;
  let repetitivePairs = 0;

  for (const [_actorId, posts] of postsByActor) {
    if (posts.length < 2) continue;

    for (let i = 0; i < posts.length; i++) {
      for (let j = i + 1; j < posts.length; j++) {
        totalPairs++;
        const sim = tokenOverlap(posts[i], posts[j]);
        if (sim > 0.85) {
          repetitivePairs++;
        }
      }
    }
  }

  return totalPairs > 0 ? repetitivePairs / totalPairs : 0;
}

/**
 * Simple Jaccard token overlap between two texts.
 */
function tokenOverlap(a: string, b: string): number {
  const tokensA = new Set(
    a.toLowerCase().split(/\s+/).filter(Boolean)
  );
  const tokensB = new Set(
    b.toLowerCase().split(/\s+/).filter(Boolean)
  );

  if (tokensA.size === 0 && tokensB.size === 0) return 1.0;
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }

  const union = new Set([...tokensA, ...tokensB]).size;
  return union > 0 ? intersection / union : 0;
}

// ═══════════════════════════════════════════════════════
// RUNTIME METRICS
// ═══════════════════════════════════════════════════════

export function computeRuntimeMetrics(
  rounds: Array<{ wall_time_ms: number | null }>,
  telemetry: {
    totalTokens: number;
    totalCostUsd: number;
  },
  searchRequestCount: number
): EvalRuntimeMetrics {
  const wallTimes = rounds
    .map((r) => r.wall_time_ms)
    .filter((w): w is number => w != null);

  const avgWallTime =
    wallTimes.length > 0
      ? wallTimes.reduce((a, b) => a + b, 0) / wallTimes.length
      : 0;

  return {
    avgWallTimePerRoundMs: Math.round(avgWallTime),
    totalTokens: telemetry.totalTokens,
    totalCostUsd: telemetry.totalCostUsd,
    totalSearchRequests: searchRequestCount,
    roundCount: rounds.length,
  };
}

// ═══════════════════════════════════════════════════════
// COMPARISON
// ═══════════════════════════════════════════════════════

export interface MetricComparison {
  metric: string;
  baseline: number;
  variant: number;
  delta: number;
  deltaPercent: number;
  direction: "better" | "worse" | "neutral";
}

/**
 * Compare two metric snapshots and produce a summary of improvements/regressions.
 */
export function compareMetrics(
  baseline: EvalMetricsSnapshot,
  variant: EvalMetricsSnapshot
): MetricComparison[] {
  const comparisons: MetricComparison[] = [];

  const lowerIsBetter = ["contradictionRate", "repetitionRate"];
  const higherIsBetter = ["stanceContinuity", "relationContinuity"];

  for (const key of lowerIsBetter) {
    const bVal = (baseline.quality as unknown as Record<string, number>)[key] ?? 0;
    const vVal = (variant.quality as unknown as Record<string, number>)[key] ?? 0;
    const delta = vVal - bVal;
    const deltaPercent = bVal !== 0 ? (delta / bVal) * 100 : 0;
    comparisons.push({
      metric: key,
      baseline: bVal,
      variant: vVal,
      delta,
      deltaPercent,
      direction: delta < 0 ? "better" : delta > 0 ? "worse" : "neutral",
    });
  }

  for (const key of higherIsBetter) {
    const bVal = (baseline.quality as unknown as Record<string, number>)[key] ?? 0;
    const vVal = (variant.quality as unknown as Record<string, number>)[key] ?? 0;
    const delta = vVal - bVal;
    const deltaPercent = bVal !== 0 ? (delta / bVal) * 100 : 0;
    comparisons.push({
      metric: key,
      baseline: bVal,
      variant: vVal,
      delta,
      deltaPercent,
      direction: delta > 0 ? "better" : delta < 0 ? "worse" : "neutral",
    });
  }

  // Runtime regression checks
  const rtBase = baseline.runtime;
  const rtVar = variant.runtime;
  const costDelta = rtVar.totalCostUsd - rtBase.totalCostUsd;
  const costPct = rtBase.totalCostUsd !== 0 ? (costDelta / rtBase.totalCostUsd) * 100 : 0;
  comparisons.push({
    metric: "totalCostUsd",
    baseline: rtBase.totalCostUsd,
    variant: rtVar.totalCostUsd,
    delta: costDelta,
    deltaPercent: costPct,
    direction: costPct > 50 ? "worse" : costPct < -10 ? "better" : "neutral",
  });

  return comparisons;
}
