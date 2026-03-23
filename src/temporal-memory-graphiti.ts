/**
 * temporal-memory-graphiti.ts — Graphiti-backed TemporalMemoryProvider
 *
 * This is a placeholder until the Graphiti spike (Phase A1) validates
 * the approach. The full implementation will be built in Phase A2.
 *
 * Import hygiene: imports from src/types.ts, NOT src/db.ts barrel.
 * Reference: PLAN_PRODUCT_EVOLUTION.md §4.3, §4.9
 */

import type { TemporalMemoryProvider } from "./temporal-memory.js";
import type { TemporalEpisode } from "./types.js";

// ═══════════════════════════════════════════════════════
// GRAPHITI PROVIDER — stub (full impl in Phase A2)
// ═══════════════════════════════════════════════════════

class GraphitiTemporalMemoryProvider implements TemporalMemoryProvider {
  constructor(private readonly endpoint: string) {}

  async healthCheck(): Promise<boolean> {
    // Phase A2: connect to FalkorDB/Neo4j and verify
    // Returns false until the real Graphiti integration is implemented after the spike.
    return false;
  }

  async appendEpisodes(_runId: string, _episodes: TemporalEpisode[]): Promise<void> {
    // Phase A3: ingest episodes into Graphiti
    // Silently discard until real implementation — outbox rows remain as "pending"
    // and will be synced once the real provider is implemented.
  }

  async queryActorContext(
    _runId: string,
    _actorId: string,
    _query?: string
  ): Promise<string> {
    // Phase A4: query actor temporal context from Graphiti
    return "";
  }

  async queryNarrativeContext(
    _runId: string,
    _topics: string[]
  ): Promise<string> {
    // Phase A4: query narrative context from Graphiti
    return "";
  }

  async queryRelationshipContext(
    _runId: string,
    _actorId: string
  ): Promise<string> {
    // Phase A4: query relationship context from Graphiti
    return "";
  }
}

/**
 * Factory function — called via dynamic import from temporal-memory.ts.
 */
export function createGraphitiProvider(endpoint: string): TemporalMemoryProvider {
  return new GraphitiTemporalMemoryProvider(endpoint);
}
