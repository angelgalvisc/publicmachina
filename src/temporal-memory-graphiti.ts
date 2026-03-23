/**
 * temporal-memory-graphiti.ts — FalkorDB-backed TemporalMemoryProvider
 *
 * Uses FalkorDB (Redis-compatible graph database) to store temporal episodes
 * as a property graph with validity windows, enabling:
 *   - Facts with temporal provenance (valid_from, valid_to)
 *   - Contradiction detection (new fact invalidates old)
 *   - Relationship history (follow/block/mute with round ranges)
 *   - Rich contextual retrieval via Cypher queries
 *
 * Import hygiene: imports from src/types.ts, NOT src/db.ts barrel.
 * Reference: PLAN_PRODUCT_EVOLUTION.md §4.3, §4.9
 */

import type { TemporalMemoryProvider } from "./temporal-memory.js";
import type { TemporalEpisode } from "./types.js";

// ═══════════════════════════════════════════════════════
// FALKORDB PROVIDER — real implementation
// ═══════════════════════════════════════════════════════

/**
 * Parse endpoint string into host:port.
 * Accepts: "localhost:6379", "bolt://localhost:6379", "redis://host:port"
 */
function parseEndpoint(endpoint: string): { host: string; port: number } {
  const cleaned = endpoint.replace(/^(bolt|redis|falkor):\/\//, "");
  const [host, portStr] = cleaned.split(":");
  return { host: host || "localhost", port: parseInt(portStr || "6379", 10) };
}

class FalkorDBTemporalMemoryProvider implements TemporalMemoryProvider {
  private db: any = null;
  private graph: any = null;
  private readonly graphName: string;
  private connected = false;

  constructor(
    private readonly endpoint: string,
    graphName?: string
  ) {
    this.graphName = graphName ?? "publicmachina_temporal";
  }

  private async ensureConnected(): Promise<boolean> {
    if (this.connected && this.graph) return true;

    try {
      const { FalkorDB } = await import("falkordb");
      const { host, port } = parseEndpoint(this.endpoint);
      this.db = await FalkorDB.connect({ socket: { host, port } });
      this.graph = this.db.selectGraph(this.graphName);

      // Create indexes for efficient queries
      await this.ensureSchema();
      this.connected = true;
      return true;
    } catch (err) {
      console.warn(`[temporal-memory] FalkorDB connection failed: ${(err as Error).message}`);
      this.connected = false;
      return false;
    }
  }

  private async ensureSchema(): Promise<void> {
    if (!this.graph) return;

    const schemaQueries = [
      // Episode nodes
      "CREATE INDEX IF NOT EXISTS FOR (e:Episode) ON (e.run_id)",
      "CREATE INDEX IF NOT EXISTS FOR (e:Episode) ON (e.actor_id)",
      "CREATE INDEX IF NOT EXISTS FOR (e:Episode) ON (e.round_num)",
      "CREATE INDEX IF NOT EXISTS FOR (e:Episode) ON (e.episode_type)",
      // Actor nodes
      "CREATE INDEX IF NOT EXISTS FOR (a:Actor) ON (a.actor_id)",
      // Fact nodes (beliefs, opinions, stances)
      "CREATE INDEX IF NOT EXISTS FOR (f:Fact) ON (f.actor_id)",
      "CREATE INDEX IF NOT EXISTS FOR (f:Fact) ON (f.valid_from)",
    ];

    for (const q of schemaQueries) {
      try {
        await this.graph.query(q);
      } catch {
        // Index might already exist or syntax not supported — not fatal
      }
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const ok = await this.ensureConnected();
      if (!ok) return false;

      // Ping with a simple query
      await this.graph.query("RETURN 1 AS ping");
      return true;
    } catch {
      return false;
    }
  }

  async appendEpisodes(runId: string, episodes: TemporalEpisode[]): Promise<void> {
    if (episodes.length === 0) return;
    if (!await this.ensureConnected()) {
      throw new Error("FalkorDB not connected");
    }

    for (const ep of episodes) {
      try {
        // Create episode node
        await this.graph.query(
          `CREATE (e:Episode {
            id: $id,
            run_id: $runId,
            round_num: $roundNum,
            episode_type: $type,
            actor_id: $actorId,
            target_actor_id: $targetActorId,
            topic: $topic,
            content: $content,
            created_at: $createdAt
          })`,
          {
            params: {
              id: ep.id,
              runId,
              roundNum: ep.round_num,
              type: ep.episode_type,
              actorId: ep.actor_id,
              targetActorId: ep.target_actor_id ?? "",
              topic: ep.topic ?? "",
              content: ep.content,
              createdAt: ep.created_at,
            },
          }
        );

        // Ensure Actor node exists and link
        await this.graph.query(
          `MERGE (a:Actor {actor_id: $actorId, run_id: $runId})
           WITH a
           MATCH (e:Episode {id: $epId})
           CREATE (a)-[:PERFORMED {round: $roundNum}]->(e)`,
          {
            params: {
              actorId: ep.actor_id,
              runId,
              epId: ep.id,
              roundNum: ep.round_num,
            },
          }
        );

        // Handle belief/opinion episodes — create Fact nodes with temporal validity
        if (ep.episode_type === "belief_updated" || ep.episode_type === "opinion_expressed") {
          // Invalidate previous fact on the same topic for this actor
          if (ep.topic) {
            await this.graph.query(
              `MATCH (f:Fact {actor_id: $actorId, run_id: $runId, topic: $topic})
               WHERE f.valid_to IS NULL OR f.valid_to = -1
               SET f.valid_to = $roundNum, f.invalidated_by = $epId`,
              {
                params: {
                  actorId: ep.actor_id,
                  runId,
                  topic: ep.topic,
                  roundNum: ep.round_num,
                  epId: ep.id,
                },
              }
            );
          }

          // Create new fact
          await this.graph.query(
            `CREATE (f:Fact {
              id: $factId,
              actor_id: $actorId,
              run_id: $runId,
              topic: $topic,
              content: $content,
              valid_from: $roundNum,
              valid_to: -1,
              source_episode: $epId
            })`,
            {
              params: {
                factId: `fact-${ep.id}`,
                actorId: ep.actor_id,
                runId,
                topic: ep.topic ?? "general",
                content: ep.content,
                roundNum: ep.round_num,
                epId: ep.id,
              },
            }
          );
        }

        // Handle relationship episodes — track with temporal provenance
        if (ep.episode_type === "follow_changed" || ep.episode_type === "block_changed" ||
            ep.episode_type === "mute_changed") {
          if (ep.target_actor_id) {
            const relType = ep.episode_type === "follow_changed" ? "FOLLOWS"
              : ep.episode_type === "block_changed" ? "BLOCKS"
              : "MUTES";

            await this.graph.query(
              `MERGE (a:Actor {actor_id: $actorId, run_id: $runId})
               MERGE (b:Actor {actor_id: $targetId, run_id: $runId})
               CREATE (a)-[:${relType} {since_round: $roundNum, episode_id: $epId}]->(b)`,
              {
                params: {
                  actorId: ep.actor_id,
                  runId,
                  targetId: ep.target_actor_id,
                  roundNum: ep.round_num,
                  epId: ep.id,
                },
              }
            );
          }
        }
      } catch (err) {
        // Log but don't fail the entire batch — some episodes may have graph issues
        console.warn(`[temporal-memory] Failed to ingest episode ${ep.id}: ${(err as Error).message}`);
      }
    }
  }

  async queryActorContext(
    runId: string,
    actorId: string,
    _query?: string
  ): Promise<string> {
    if (!await this.ensureConnected()) return "";

    try {
      const sections: string[] = [];

      // 1. Current active beliefs/opinions (valid_to = -1 means still active)
      const factsResult = await this.graph.query(
        `MATCH (f:Fact {actor_id: $actorId, run_id: $runId})
         WHERE f.valid_to = -1
         RETURN f.topic AS topic, f.content AS content, f.valid_from AS since
         ORDER BY f.valid_from DESC
         LIMIT 10`,
        { params: { actorId, runId } }
      );

      if (factsResult.data && factsResult.data.length > 0) {
        sections.push("Current beliefs:");
        for (const row of factsResult.data) {
          sections.push(`  - [since round ${row.since}] ${row.topic}: ${row.content}`);
        }
      }

      // 2. Changed beliefs (invalidated facts — shows evolution)
      const changedResult = await this.graph.query(
        `MATCH (f:Fact {actor_id: $actorId, run_id: $runId})
         WHERE f.valid_to <> -1
         RETURN f.topic AS topic, f.content AS content,
                f.valid_from AS from_round, f.valid_to AS to_round
         ORDER BY f.valid_to DESC
         LIMIT 5`,
        { params: { actorId, runId } }
      );

      if (changedResult.data && changedResult.data.length > 0) {
        sections.push("Changed positions:");
        for (const row of changedResult.data) {
          sections.push(`  - [rounds ${row.from_round}-${row.to_round}] ${row.topic}: ${row.content} (no longer held)`);
        }
      }

      // 3. Recent actions
      const actionsResult = await this.graph.query(
        `MATCH (a:Actor {actor_id: $actorId, run_id: $runId})-[:PERFORMED]->(e:Episode)
         RETURN e.episode_type AS type, e.content AS content, e.round_num AS round
         ORDER BY e.round_num DESC
         LIMIT 8`,
        { params: { actorId, runId } }
      );

      if (actionsResult.data && actionsResult.data.length > 0) {
        sections.push("Recent actions:");
        for (const row of actionsResult.data) {
          sections.push(`  - [round ${row.round}] ${row.type}: ${row.content}`);
        }
      }

      return sections.join("\n");
    } catch (err) {
      console.warn(`[temporal-memory] Actor context query failed: ${(err as Error).message}`);
      return "";
    }
  }

  async queryNarrativeContext(
    runId: string,
    topics: string[]
  ): Promise<string> {
    if (!await this.ensureConnected() || topics.length === 0) return "";

    try {
      const sections: string[] = [];

      for (const topic of topics.slice(0, 3)) {
        // Find all facts related to this topic, grouped by validity
        const result = await this.graph.query(
          `MATCH (f:Fact {run_id: $runId, topic: $topic})
           RETURN f.actor_id AS actor, f.content AS content,
                  f.valid_from AS from_round, f.valid_to AS to_round
           ORDER BY f.valid_from DESC
           LIMIT 10`,
          { params: { runId, topic } }
        );

        if (result.data && result.data.length > 0) {
          sections.push(`Topic "${topic}":`);
          const active = result.data.filter((r: any) => r.to_round === -1);
          const expired = result.data.filter((r: any) => r.to_round !== -1);

          if (active.length > 0) {
            sections.push("  Current positions:");
            for (const row of active) {
              sections.push(`    - ${row.actor}: ${row.content} (since round ${row.from_round})`);
            }
          }
          if (expired.length > 0) {
            sections.push("  Changed positions:");
            for (const row of expired.slice(0, 3)) {
              sections.push(`    - ${row.actor}: ${row.content} (rounds ${row.from_round}-${row.to_round})`);
            }
          }
        }
      }

      return sections.join("\n");
    } catch (err) {
      console.warn(`[temporal-memory] Narrative context query failed: ${(err as Error).message}`);
      return "";
    }
  }

  async queryRelationshipContext(
    runId: string,
    actorId: string
  ): Promise<string> {
    if (!await this.ensureConnected()) return "";

    try {
      const sections: string[] = [];

      // Query all outgoing relationships with temporal provenance
      for (const relType of ["FOLLOWS", "BLOCKS", "MUTES"]) {
        const result = await this.graph.query(
          `MATCH (a:Actor {actor_id: $actorId, run_id: $runId})-[r:${relType}]->(b:Actor)
           RETURN b.actor_id AS target, r.since_round AS since
           ORDER BY r.since_round DESC
           LIMIT 10`,
          { params: { actorId, runId } }
        );

        if (result.data && result.data.length > 0) {
          sections.push(`${relType.toLowerCase()}:`);
          for (const row of result.data) {
            sections.push(`  - ${row.target} (since round ${row.since})`);
          }
        }
      }

      return sections.join("\n");
    } catch (err) {
      console.warn(`[temporal-memory] Relationship context query failed: ${(err as Error).message}`);
      return "";
    }
  }

  /** Disconnect from FalkorDB. */
  async close(): Promise<void> {
    if (this.db) {
      try {
        await this.db.close();
      } catch { /* ignore */ }
      this.db = null;
      this.graph = null;
      this.connected = false;
    }
  }
}

/**
 * Factory function — called via dynamic import from temporal-memory.ts.
 */
export function createGraphitiProvider(endpoint: string): TemporalMemoryProvider {
  return new FalkorDBTemporalMemoryProvider(endpoint);
}
