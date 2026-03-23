/**
 * temporal-memory.ts — TemporalMemoryProvider abstraction
 *
 * Defines the interface for temporal memory backends (Graphiti, Noop).
 * The engine uses this to:
 *   - Write episodes after each round (via outbox)
 *   - Query context before Tier A/B decisions
 *
 * Import hygiene: imports from src/types.ts, NOT src/db.ts barrel.
 * Reference: PLAN_PRODUCT_EVOLUTION.md §4.3
 */

import type { TemporalEpisode } from "./types.js";

// ═══════════════════════════════════════════════════════
// PROVIDER INTERFACE
// ═══════════════════════════════════════════════════════

/**
 * TemporalMemoryProvider — interface for temporal memory backends.
 *
 * Implementations:
 *   - NoopTemporalMemoryProvider: default, does nothing
 *   - GraphitiTemporalMemoryProvider: writes/reads from Graphiti (Phase A2+)
 */
export interface TemporalMemoryProvider {
  /** Returns true if the backend is reachable and healthy. */
  healthCheck(): Promise<boolean>;

  /** Append a batch of episodes to the temporal memory store. */
  appendEpisodes(runId: string, episodes: TemporalEpisode[]): Promise<void>;

  /**
   * Query relevant temporal context for an actor's next decision.
   * Returns a formatted string ready to inject into the prompt.
   */
  queryActorContext(
    runId: string,
    actorId: string,
    query?: string
  ): Promise<string>;

  /**
   * Query narrative-level temporal context (shifts, displacements, dominant themes).
   */
  queryNarrativeContext(
    runId: string,
    topics: string[]
  ): Promise<string>;

  /**
   * Query relationship history for an actor (changed alliances, follows/blocks
   * with temporal provenance).
   */
  queryRelationshipContext(
    runId: string,
    actorId: string
  ): Promise<string>;
}

// ═══════════════════════════════════════════════════════
// NOOP PROVIDER — default, zero overhead
// ═══════════════════════════════════════════════════════

/**
 * NoopTemporalMemoryProvider — returns empty results, always healthy.
 *
 * Used when temporal memory is disabled (the default).
 * Ensures the engine never branches on null checks — it always
 * has a provider, it just doesn't do anything.
 */
export class NoopTemporalMemoryProvider implements TemporalMemoryProvider {
  async healthCheck(): Promise<boolean> {
    return true;
  }

  async appendEpisodes(_runId: string, _episodes: TemporalEpisode[]): Promise<void> {
    // Silently discard — no temporal memory backend configured
  }

  async queryActorContext(
    _runId: string,
    _actorId: string,
    _query?: string
  ): Promise<string> {
    return "";
  }

  async queryNarrativeContext(
    _runId: string,
    _topics: string[]
  ): Promise<string> {
    return "";
  }

  async queryRelationshipContext(
    _runId: string,
    _actorId: string
  ): Promise<string> {
    return "";
  }
}

// ═══════════════════════════════════════════════════════
// FACTORY
// ═══════════════════════════════════════════════════════

export interface TemporalMemoryFactoryConfig {
  enabled: boolean;
  provider: "noop" | "graphiti";
  graphitiEndpoint?: string;
}

/**
 * Create a TemporalMemoryProvider based on config.
 *
 * When Graphiti is enabled but the import fails (not installed),
 * falls back to Noop with a warning.
 */
export async function createTemporalMemoryProvider(
  config: TemporalMemoryFactoryConfig
): Promise<TemporalMemoryProvider> {
  if (!config.enabled || config.provider === "noop") {
    return new NoopTemporalMemoryProvider();
  }

  if (config.provider === "graphiti") {
    // Dynamic import to avoid hard dependency on graphiti-core
    try {
      const mod = await import("./temporal-memory-graphiti.js");
      const provider = mod.createGraphitiProvider(config.graphitiEndpoint ?? "bolt://localhost:6379");

      // Verify the provider is actually functional (not just a stub)
      const healthy = await provider.healthCheck();
      if (!healthy) {
        console.warn(
          `[temporal-memory] Graphiti provider loaded but healthCheck returned false. ` +
          `The Graphiti integration is not yet fully implemented (Phase A1 spike required). ` +
          `Episodes will be written to the outbox but NOT synced to a graph backend. ` +
          `Falling back to NoopTemporalMemoryProvider for context retrieval.`
        );
        // Return a hybrid: Noop for reads (no false context), but the outbox
        // write path in the mapper still works for future sync.
        return new NoopTemporalMemoryProvider();
      }

      return provider;
    } catch (err) {
      console.warn(
        `[temporal-memory] Failed to load Graphiti provider: ${(err as Error).message}. ` +
        `Falling back to NoopTemporalMemoryProvider.`
      );
      return new NoopTemporalMemoryProvider();
    }
  }

  return new NoopTemporalMemoryProvider();
}
