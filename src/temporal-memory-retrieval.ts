/**
 * temporal-memory-retrieval.ts — Query Graphiti and compose context for decisions
 *
 * Responsibilities:
 *   1. Query temporal memory for actor/narrative/relationship context
 *   2. Compose a formatted text pack within the tier's context budget
 *   3. Handle fallback gracefully when Graphiti is unavailable
 *
 * Import hygiene: imports from src/types.ts, NOT src/db.ts barrel.
 * Reference: PLAN_PRODUCT_EVOLUTION.md §4.7
 */

import type { TemporalMemoryProvider } from "./temporal-memory.js";
import type { TemporalMemoryConfig } from "./config.js";

// ═══════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════

export interface TemporalContextBudget {
  maxFacts: number;
  maxRelationships: number;
  maxContradictions?: number;
}

export interface TemporalContextResult {
  text: string;
  factsRetrieved: number;
  relationshipsRetrieved: number;
  contradictionsRetrieved: number;
  latencyMs: number;
  source: "graphiti" | "fallback";
}

// ═══════════════════════════════════════════════════════
// RETRIEVE + COMPOSE
// ═══════════════════════════════════════════════════════

/**
 * Query temporal memory and compose a formatted context string
 * ready to inject into DecisionRequest.temporalMemoryContext.
 *
 * Returns empty result if:
 *   - provider is Noop
 *   - provider health check fails
 *   - all queries return empty
 *   - any error occurs (graceful fallback)
 */
export async function retrieveTemporalContext(
  provider: TemporalMemoryProvider,
  runId: string,
  actorId: string,
  actorTopics: string[],
  tier: "A" | "B",
  config: TemporalMemoryConfig
): Promise<TemporalContextResult> {
  const t0 = Date.now();
  const budget = tier === "A"
    ? config.contextBudget.tierA
    : config.contextBudget.tierB;

  try {
    // Query all three dimensions in parallel
    const [actorContext, narrativeContext, relationshipContext] = await Promise.all([
      provider.queryActorContext(runId, actorId),
      provider.queryNarrativeContext(runId, actorTopics),
      provider.queryRelationshipContext(runId, actorId),
    ]);

    // If all empty, return empty result (Noop provider or no data yet)
    if (!actorContext && !narrativeContext && !relationshipContext) {
      return {
        text: "",
        factsRetrieved: 0,
        relationshipsRetrieved: 0,
        contradictionsRetrieved: 0,
        latencyMs: Date.now() - t0,
        source: "graphiti",
      };
    }

    // Compose within budget
    const composed = composeTemporalMemoryPack(
      actorContext,
      narrativeContext,
      relationshipContext,
      budget
    );

    return {
      ...composed,
      latencyMs: Date.now() - t0,
      source: "graphiti",
    };
  } catch (err) {
    // Graceful fallback — log but don't crash
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[temporal-memory] Retrieval failed for actor ${actorId}: ${message}. Continuing without temporal context.`
    );
    return {
      text: "",
      factsRetrieved: 0,
      relationshipsRetrieved: 0,
      contradictionsRetrieved: 0,
      latencyMs: Date.now() - t0,
      source: "fallback",
    };
  }
}

// ═══════════════════════════════════════════════════════
// COMPOSE MEMORY PACK
// ═══════════════════════════════════════════════════════

/**
 * Format temporal memory query results into a prompt-ready text block.
 * Applies the context budget to limit token usage per tier.
 *
 * Budget: PLAN_PRODUCT_EVOLUTION.md §4.7
 *   Tier A: up to 10 facts + 5 relationships + 3 contradictions (~800-1200 tokens)
 *   Tier B: up to 3 facts + 2 relationships (~300-500 tokens)
 */
export function composeTemporalMemoryPack(
  actorContext: string,
  narrativeContext: string,
  relationshipContext: string,
  budget: TemporalContextBudget
): Omit<TemporalContextResult, "latencyMs" | "source"> {
  const sections: string[] = [];
  let factsRetrieved = 0;
  let relationshipsRetrieved = 0;
  let contradictionsRetrieved = 0;

  // Parse and trim actor context (facts + contradictions)
  if (actorContext) {
    const lines = actorContext.split("\n").filter((l) => l.trim());
    const factLines = lines.slice(0, budget.maxFacts);
    factsRetrieved = factLines.length;

    if (budget.maxContradictions) {
      const contradictionLines = lines
        .filter((l) => l.toLowerCase().includes("contradict") || l.toLowerCase().includes("invalidat"))
        .slice(0, budget.maxContradictions);
      contradictionsRetrieved = contradictionLines.length;

      if (contradictionLines.length > 0) {
        factLines.push(
          ...contradictionLines.filter((l) => !factLines.includes(l))
        );
      }
    }

    if (factLines.length > 0) {
      sections.push("TEMPORAL FACTS:\n" + factLines.join("\n"));
    }
  }

  // Parse and trim relationship context
  if (relationshipContext) {
    const lines = relationshipContext.split("\n").filter((l) => l.trim());
    const relLines = lines.slice(0, budget.maxRelationships);
    relationshipsRetrieved = relLines.length;

    if (relLines.length > 0) {
      sections.push("RELATIONSHIP HISTORY:\n" + relLines.join("\n"));
    }
  }

  // Parse and trim narrative context
  if (narrativeContext) {
    const lines = narrativeContext.split("\n").filter((l) => l.trim());
    // Narrative lines share the facts budget remainder
    const narrativeLimit = Math.max(0, budget.maxFacts - factsRetrieved);
    const narLines = lines.slice(0, Math.max(2, narrativeLimit));

    if (narLines.length > 0) {
      sections.push("NARRATIVE CONTEXT:\n" + narLines.join("\n"));
    }
  }

  const text = sections.length > 0 ? sections.join("\n\n") : "";

  return {
    text,
    factsRetrieved,
    relationshipsRetrieved,
    contradictionsRetrieved,
  };
}
