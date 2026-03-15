/**
 * report.ts — SQL-to-Report pipeline
 *
 * Computes quantitative metrics from a completed simulation run
 * and optionally generates an LLM narrative summary.
 *
 * CRITICAL: No raw JSON parsing in this file.
 * All data comes from normalized columns via store methods.
 */

import type { GraphStore } from "./db.js";
import type { LLMClient } from "./llm.js";

// ═══════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════

export interface ReportMetrics {
  run_id: string;
  hypothesis: string | null;
  rounds_completed: number;
  posts_per_round: Array<{ round: number; posts: number; comments: number; reposts: number }>;
  total_posts: number;
  total_actions: number;
  avg_active_actors: number;
  sentiment_curves: Array<{
    topic: string;
    intensity: number;
    dominant_sentiment: number;
    peak_round: number | null;
    total_posts: number;
  }>;
  top_actors_by_reach: Array<{
    actor_id: string;
    actor_name: string;
    total_reach: number;
    total_likes: number;
    total_posts: number;
    cognition_tier: string;
  }>;
  tier_breakdown: {
    tier_a_calls: number;
    tier_b_calls: number;
    tier_c_actions: number;
  };
  fatigue_curves: Array<{
    topic: string;
    current_intensity: number;
    peak_round: number | null;
    status: "active" | "fatigued" | "extinct";
  }>;
  event_rounds: number[];
}

export interface ReportOutput {
  metrics: ReportMetrics;
  narrative: string | null;
}

// ═══════════════════════════════════════════════════════
// computeMetrics
// ═══════════════════════════════════════════════════════

export function computeMetrics(store: GraphStore, runId: string): ReportMetrics {
  const run = store.getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);

  const summary = store.getRunRoundSummary(runId);
  const postsPerRound = store.getPostsPerRound(runId);
  const narratives = store.getNarrativesByRun(runId);
  const topActors = store.getTopActorsByReach(runId, 10);
  const tierTotals = store.getRunTierCallTotals(runId);
  const eventRounds = store.getEventRounds(runId);

  // Derive fatigue status from intensity
  const fatigueCurves = narratives.map((n) => ({
    topic: n.topic,
    current_intensity: n.current_intensity,
    peak_round: n.peak_round,
    status: (n.current_intensity >= 0.5
      ? "active"
      : n.current_intensity >= 0.1
        ? "fatigued"
        : "extinct") as "active" | "fatigued" | "extinct",
  }));

  const sentimentCurves = narratives.map((n) => ({
    topic: n.topic,
    intensity: n.current_intensity,
    dominant_sentiment: n.dominant_sentiment,
    peak_round: n.peak_round,
    total_posts: n.total_posts,
  }));

  return {
    run_id: runId,
    hypothesis: run.hypothesis ?? null,
    rounds_completed: summary.roundsCompleted,
    posts_per_round: postsPerRound,
    total_posts: summary.totalPosts,
    total_actions: summary.totalActions,
    avg_active_actors: summary.avgActiveActors,
    sentiment_curves: sentimentCurves,
    top_actors_by_reach: topActors,
    tier_breakdown: {
      tier_a_calls: tierTotals.tierACalls,
      tier_b_calls: tierTotals.tierBCalls,
      tier_c_actions: tierTotals.tierCActions,
    },
    fatigue_curves: fatigueCurves,
    event_rounds: eventRounds,
  };
}

// ═══════════════════════════════════════════════════════
// generateNarrative
// ═══════════════════════════════════════════════════════

export async function generateNarrative(llm: LLMClient, metrics: ReportMetrics): Promise<string> {
  const system = `You are a social simulation analyst. Given quantitative metrics from a simulation run, produce a concise narrative summary (3-5 paragraphs) that highlights key findings, emergent patterns, and notable dynamics.`;

  // Build formatted text summary (NOT raw JSON)
  const lines: string[] = [];
  if (metrics.hypothesis) lines.push(`Hypothesis: ${metrics.hypothesis}`);
  lines.push(`Rounds completed: ${metrics.rounds_completed}`);
  lines.push(`Total posts: ${metrics.total_posts}, Total actions: ${metrics.total_actions}`);
  lines.push(`Avg active actors/round: ${metrics.avg_active_actors.toFixed(1)}`);

  if (metrics.sentiment_curves.length > 0) {
    lines.push(`\nSentiment by topic:`);
    for (const s of metrics.sentiment_curves) {
      lines.push(`  ${s.topic}: sentiment=${s.dominant_sentiment.toFixed(2)}, intensity=${s.intensity.toFixed(2)}, posts=${s.total_posts}`);
    }
  }

  if (metrics.top_actors_by_reach.length > 0) {
    lines.push(`\nTop actors by reach:`);
    for (const a of metrics.top_actors_by_reach.slice(0, 5)) {
      lines.push(`  ${a.actor_name} (${a.cognition_tier}): reach=${a.total_reach}, likes=${a.total_likes}, posts=${a.total_posts}`);
    }
  }

  lines.push(`\nTier breakdown: A=${metrics.tier_breakdown.tier_a_calls}, B=${metrics.tier_breakdown.tier_b_calls}, C=${metrics.tier_breakdown.tier_c_actions}`);

  if (metrics.fatigue_curves.length > 0) {
    lines.push(`\nNarrative fatigue:`);
    for (const f of metrics.fatigue_curves) {
      lines.push(`  ${f.topic}: ${f.status} (intensity=${f.current_intensity.toFixed(2)})`);
    }
  }

  if (metrics.event_rounds.length > 0) {
    lines.push(`\nEvent injection rounds: ${metrics.event_rounds.join(", ")}`);
  }

  const prompt = lines.join("\n");

  const response = await llm.complete("report", prompt, {
    system,
    maxTokens: 4096,
    temperature: 0.3,
  });

  return response.content;
}

// ═══════════════════════════════════════════════════════
// generateReport
// ═══════════════════════════════════════════════════════

export async function generateReport(
  store: GraphStore,
  runId: string,
  llm?: LLMClient
): Promise<ReportOutput> {
  const metrics = computeMetrics(store, runId);

  let narrative: string | null = null;
  if (llm && llm.hasProvider("report")) {
    narrative = await generateNarrative(llm, metrics);
  }

  return { metrics, narrative };
}
