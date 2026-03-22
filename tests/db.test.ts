/**
 * db.test.ts — Verification for Step 1.1 (db.ts)
 *
 * Ref: CLAUDE.md §Step 1.1 verification criteria
 * - new SQLiteGraphStore('test.db') creates all tables
 * - All indices exist (query sqlite_master)
 * - FTS5 entities_fts works (INSERT + search)
 * - exposure_summary VIEW returns correct data
 * - FK constraints active (INSERT with invalid FK → error)
 * - Run-scoped queries work
 * - buildPlatformState returns proper projection
 * - decision_cache lookup by (request_hash, model_id, prompt_version)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { unlinkSync, existsSync } from "node:fs";
import Database from "better-sqlite3";
import {
  SQLiteGraphStore,
  uuid,
  type Post,
  type Exposure,
  type ActorRow,
  type RunManifest,
} from "../src/db.js";
import { CURRENT_SCHEMA_VERSION } from "../src/schema.js";

const TEST_DB = "/tmp/publicmachina-test-db.sqlite";

describe("SQLiteGraphStore", () => {
  let store: SQLiteGraphStore;

  beforeEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    store = new SQLiteGraphStore(TEST_DB);
  });

  afterEach(() => {
    store.close();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  // ─── Schema creation ───

  it("creates all tables on initialization", () => {
    const tables = store.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
      )
      .all() as Array<{ name: string }>;

    const tableNames = tables.map((t) => t.name);

    const expectedTables = [
      "actor_interest_embeddings",
      "actor_beliefs",
      "actor_memories",
      "actor_topics",
      "actors",
      "chunks",
      "claims",
      "communities",
      "community_overlap",
      "decision_traces",
      "decision_cache",
      "documents",
      "edge_claims",
      "edge_types",
      "edges",
      "entities",
      "entity_aliases",
      "entity_claims",
      "entity_merges",
      "entity_types",
      "exposures",
      "follows",
      "narratives",
      "post_topics",
      "posts",
      "post_embeddings",
      "rounds",
      "run_manifest",
      "run_scaffolds",
      "search_cache",
      "search_requests",
      "snapshots",
      "telemetry",
    ];

    for (const table of expectedTables) {
      expect(tableNames).toContain(table);
    }
  });

  it("sets the schema user_version to the current migration level", () => {
    const version = store.db.pragma("user_version", { simple: true }) as number;
    expect(version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("creates all indices", () => {
    const indices = store.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name`
      )
      .all() as Array<{ name: string }>;

    const indexNames = indices.map((i) => i.name);

    const expectedIndices = [
      "idx_decision_cache_lookup",
      "idx_decision_traces_run_round",
      "idx_decision_traces_actor",
      "idx_posts_run_round",
      "idx_posts_author",
      "idx_telemetry_run_round",
      "idx_telemetry_actor",
      "idx_exposures_run_round",
      "idx_narratives_run_topic",
      "idx_actor_memories_actor_round",
      "idx_actor_memories_salience",
      "idx_actors_run",
      "idx_entity_aliases_alias",
      "idx_entity_merges_merged",
      "idx_edges_source",
      "idx_edges_target",
      "idx_claims_chunk",
      "idx_chunks_doc",
      "idx_actor_topics_topic",
      "idx_post_topics_topic",
      "idx_actor_beliefs_topic",
      "idx_post_embeddings_model",
      "idx_actor_interest_embeddings_model",
      "idx_search_cache_lookup",
      "idx_search_requests_actor_round",
    ];

    for (const idx of expectedIndices) {
      expect(indexNames).toContain(idx);
    }
  });

  it("creates the exposure_summary view", () => {
    const views = store.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='view'`)
      .all() as Array<{ name: string }>;

    expect(views.map((v) => v.name)).toContain("exposure_summary");
  });

  it("creates the entities_fts virtual table", () => {
    const tables = store.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name = 'entities_fts'`
      )
      .all();

    expect(tables.length).toBe(1);
  });

  it("upgrades a legacy database to the current schema version", () => {
    store.close();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);

    const legacy = new Database(TEST_DB);
    legacy.exec(`
      CREATE TABLE run_manifest (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        seed INTEGER NOT NULL,
        config_snapshot TEXT NOT NULL,
        hypothesis TEXT,
        docs_hash TEXT,
        graph_revision_id TEXT NOT NULL,
        total_rounds INTEGER,
        status TEXT DEFAULT 'running',
        resumed_from TEXT,
        version TEXT
      );
      CREATE TABLE actors (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        entity_id TEXT,
        archetype TEXT NOT NULL,
        cognition_tier TEXT NOT NULL DEFAULT 'B',
        name TEXT NOT NULL,
        handle TEXT,
        personality TEXT NOT NULL,
        bio TEXT,
        age INTEGER,
        gender TEXT,
        profession TEXT,
        region TEXT,
        language TEXT DEFAULT 'es',
        stance TEXT DEFAULT 'neutral',
        sentiment_bias REAL DEFAULT 0.0,
        activity_level REAL DEFAULT 0.5,
        influence_weight REAL DEFAULT 0.5,
        community_id TEXT,
        active_hours TEXT,
        follower_count INTEGER DEFAULT 100,
        following_count INTEGER DEFAULT 50
      );
      CREATE TABLE posts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        content TEXT NOT NULL,
        reply_to TEXT,
        quote_of TEXT,
        round_num INTEGER NOT NULL,
        sim_timestamp TEXT NOT NULL,
        likes INTEGER DEFAULT 0,
        reposts INTEGER DEFAULT 0,
        comments INTEGER DEFAULT 0,
        reach INTEGER DEFAULT 0,
        sentiment REAL
      );
      CREATE TABLE snapshots (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        round_num INTEGER NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        actor_states TEXT NOT NULL,
        narrative_states TEXT NOT NULL,
        rng_state TEXT NOT NULL
      );
    `);
    legacy.pragma("user_version = 0");
    legacy.close();

    store = new SQLiteGraphStore(TEST_DB);

    const version = store.db.pragma("user_version", { simple: true }) as number;
    expect(version).toBe(CURRENT_SCHEMA_VERSION);

    const postColumns = store.db
      .prepare("PRAGMA table_info(posts)")
      .all() as Array<{ name: string }>;
    expect(postColumns.map((column) => column.name)).toContain("post_kind");
    expect(postColumns.map((column) => column.name)).toContain("moderation_status");

    const snapshotColumns = store.db
      .prepare("PRAGMA table_info(snapshots)")
      .all() as Array<{ name: string }>;
    expect(snapshotColumns.map((column) => column.name)).toContain("fired_triggers");

    const tables = store.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('run_scaffolds','decision_traces') ORDER BY name`
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual(["decision_traces", "run_scaffolds"]);
  });

  // ─── PRAGMAs ───

  it("sets WAL journal mode", () => {
    const result = store.db.pragma("journal_mode") as Array<{
      journal_mode: string;
    }>;
    expect(result[0].journal_mode).toBe("wal");
  });

  it("enables foreign keys", () => {
    const result = store.db.pragma("foreign_keys") as Array<{
      foreign_keys: number;
    }>;
    expect(result[0].foreign_keys).toBe(1);
  });

  // ─── FK constraints ───

  it("rejects invalid FK on chunks.document_id", () => {
    expect(() => {
      store.addChunk({
        id: uuid(),
        document_id: "nonexistent-doc",
        chunk_index: 0,
        content: "test",
      });
    }).toThrow();
  });

  it("rejects invalid FK on actors.run_id", () => {
    expect(() => {
      store.addActor({
        id: uuid(),
        run_id: "nonexistent-run",
        entity_id: null,
        archetype: "persona",
        cognition_tier: "B",
        name: "Test",
        handle: null,
        personality: "test persona",
        bio: null,
        age: null,
        gender: null,
        profession: null,
        region: null,
        language: "es",
        stance: "neutral",
        sentiment_bias: 0,
        activity_level: 0.5,
        influence_weight: 0.5,
        community_id: null,
        active_hours: null,
        follower_count: 100,
        following_count: 50,
      });
    }).toThrow();
  });

  // ─── Provenance chain ───

  describe("provenance", () => {
    it("full chain: document → chunk → claim → entity", () => {
      const docId = store.addDocument({
        id: uuid(),
        filename: "test.md",
        content_hash: "abc123",
        mime_type: "text/markdown",
      });

      const chunkId = store.addChunk({
        id: uuid(),
        document_id: docId,
        chunk_index: 0,
        content: "University announces tuition increase of 30%",
        token_count: 8,
      });

      const claimId = store.addClaim({
        id: uuid(),
        source_chunk_id: chunkId,
        subject: "University",
        predicate: "announces",
        object: "tuition increase 30%",
        confidence: 0.95,
        observed_at: new Date().toISOString(),
      });

      store.addEntityType({ name: "organization", description: "An org" });
      const entityId = store.addEntity({
        id: uuid(),
        type: "organization",
        name: "University",
      });

      store.linkClaimToEntity(entityId, claimId);

      const provenance = store.queryProvenance(entityId);
      expect(provenance.entity.name).toBe("University");
      expect(provenance.claims).toHaveLength(1);
      expect(provenance.claims[0].subject).toBe("University");
      expect(provenance.chunks).toHaveLength(1);
      expect(provenance.documents).toHaveLength(1);
      expect(provenance.documents[0].filename).toBe("test.md");
    });
  });

  // ─── FTS5 ───

  describe("FTS5 search", () => {
    it("finds entities by name", () => {
      store.addEntityType({ name: "person", description: "A person" });
      store.addEntity({
        id: uuid(),
        type: "person",
        name: "María López García",
      });
      store.addEntity({
        id: uuid(),
        type: "person",
        name: "Carlos Rodríguez",
      });

      const results = store.searchEntities("María");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].name).toBe("María López García");
    });

    it("returns empty for no matches", () => {
      store.addEntityType({ name: "person", description: "A person" });
      store.addEntity({
        id: uuid(),
        type: "person",
        name: "Test Person",
      });

      const results = store.searchEntities("Nonexistent");
      expect(results).toHaveLength(0);
    });
  });

  // ─── Entity resolution (merge) ───

  describe("entity merging", () => {
    it("merges entities and transfers edges", () => {
      store.addEntityType({ name: "org", description: "Organization" });
      const entityA = store.addEntity({
        id: uuid(),
        type: "org",
        name: "Ministerio de Educación",
      });
      const entityB = store.addEntity({
        id: uuid(),
        type: "org",
        name: "MinEducación",
      });
      const entityC = store.addEntity({
        id: uuid(),
        type: "org",
        name: "Some Other Org",
      });

      store.addEdgeType({
        name: "related_to",
        description: "Generic relation",
      });

      // Edge from B to C
      store.addEdge({
        id: uuid(),
        type: "related_to",
        source_id: entityB,
        target_id: entityC,
        confidence: 1.0,
      });

      // Merge B into A
      const mergeId = store.mergeEntities(
        entityA,
        entityB,
        0.92,
        "name_similarity",
        "similarity=0.92"
      );

      expect(mergeId).toBeTruthy();

      // Edge should now point from A to C
      const edges = store.db
        .prepare(`SELECT * FROM edges WHERE source_id = ?`)
        .all(entityA) as Array<{ source_id: string; target_id: string }>;
      expect(edges.length).toBeGreaterThanOrEqual(1);
      expect(edges[0].target_id).toBe(entityC);

      // Alias should be created
      const aliases = store.db
        .prepare(`SELECT * FROM entity_aliases WHERE entity_id = ?`)
        .all(entityA) as Array<{ alias: string }>;
      expect(aliases.map((a) => a.alias)).toContain("MinEducación");

      // Absorbed entity should be marked as merged
      const mergedEntity = store.db
        .prepare(`SELECT merged_into FROM entities WHERE id = ?`)
        .get(entityB) as { merged_into: string | null };
      expect(mergedEntity.merged_into).toBe(entityA);

      // Absorbed entity should NOT appear in searchEntities
      const searchResults = store.searchEntities("MinEducación");
      const searchIds = searchResults.map((e) => e.id);
      expect(searchIds).not.toContain(entityB);
    });
  });

  // ─── exposure_summary view ───

  describe("exposure_summary view", () => {
    it("aggregates exposures correctly", () => {
      // Set up minimal data
      const runId = uuid();
      store.createRun({
        id: runId,
        started_at: new Date().toISOString(),
        seed: 42,
        config_snapshot: "{}",
        graph_revision_id: "test-rev",
        status: "running",
      });

      const actorId = uuid();
      store.addActor({
        id: actorId,
        run_id: runId,
        entity_id: null,
        archetype: "persona",
        cognition_tier: "B",
        name: "Test Actor",
        handle: "@test",
        personality: "test",
        bio: null,
        age: 30,
        gender: "male",
        profession: null,
        region: null,
        language: "es",
        stance: "neutral",
        sentiment_bias: 0,
        activity_level: 0.5,
        influence_weight: 0.5,
        community_id: null,
        active_hours: null,
        follower_count: 100,
        following_count: 50,
      });

      const postId = uuid();
      store.addPost({
        id: postId,
        run_id: runId,
        author_id: actorId,
        content: "Test post",
        round_num: 0,
        sim_timestamp: new Date().toISOString(),
        likes: 0,
        reposts: 0,
        comments: 0,
        reach: 0,
      });

      const viewerId = uuid();
      store.addActor({
        id: viewerId,
        run_id: runId,
        entity_id: null,
        archetype: "persona",
        cognition_tier: "C",
        name: "Viewer",
        handle: "@viewer",
        personality: "viewer",
        bio: null,
        age: 25,
        gender: "female",
        profession: null,
        region: null,
        language: "es",
        stance: "neutral",
        sentiment_bias: 0,
        activity_level: 0.3,
        influence_weight: 0.3,
        community_id: null,
        active_hours: null,
        follower_count: 50,
        following_count: 30,
      });

      // Multiple exposures across rounds
      store.addExposure({
        actor_id: viewerId,
        post_id: postId,
        round_num: 1,
        run_id: runId,
        reaction: "seen",
      });
      store.addExposure({
        actor_id: viewerId,
        post_id: postId,
        round_num: 2,
        run_id: runId,
        reaction: "liked",
      });
      store.addExposure({
        actor_id: viewerId,
        post_id: postId,
        round_num: 3,
        run_id: runId,
        reaction: "commented",
      });

      const summary = store.db
        .prepare(
          `SELECT * FROM exposure_summary WHERE actor_id = ? AND post_id = ?`
        )
        .get(viewerId, postId) as {
        first_seen_round: number;
        last_seen_round: number;
        exposure_count: number;
        strongest_reaction: string;
      };

      expect(summary.first_seen_round).toBe(1);
      expect(summary.last_seen_round).toBe(3);
      expect(summary.exposure_count).toBe(3);
      expect(summary.strongest_reaction).toBe("commented");
    });
  });

  // ─── Decision cache ───

  describe("decision_cache", () => {
    it("stores and retrieves by (request_hash, model_id, prompt_version)", () => {
      const runId = uuid();
      store.createRun({
        id: runId,
        started_at: new Date().toISOString(),
        seed: 42,
        config_snapshot: "{}",
        graph_revision_id: "test-rev",
        status: "running",
      });

      store.cacheDecision({
        id: uuid(),
        run_id: runId,
        round_num: 1,
        actor_id: "actor-1",
        request_hash: "hash-abc",
        raw_response: '{"action":"post"}',
        parsed_decision: '{"action":"post","content":"Hello"}',
        model_id: "claude-haiku-4",
        prompt_version: "v1.0",
      });

      // Exact match
      const result = store.lookupDecision("hash-abc", "claude-haiku-4", "v1.0");
      expect(result).not.toBeNull();
      expect(result!.parsed_decision).toContain("post");

      // Wrong model → miss
      const miss1 = store.lookupDecision(
        "hash-abc",
        "claude-sonnet-4",
        "v1.0"
      );
      expect(miss1).toBeNull();

      // Wrong prompt_version → miss (prevents silent stale replay)
      const miss2 = store.lookupDecision(
        "hash-abc",
        "claude-haiku-4",
        "v2.0"
      );
      expect(miss2).toBeNull();
    });
  });

  // ─── buildPlatformState ───

  describe("buildPlatformState", () => {
    it("returns a proper PlatformState projection", () => {
      const runId = uuid();
      store.createRun({
        id: runId,
        started_at: new Date().toISOString(),
        seed: 42,
        config_snapshot: "{}",
        graph_revision_id: "test-rev",
        status: "running",
      });

      // Community (scoped by run_id)
      store.addCommunity("comm-1", runId, "Students", "Student community", 0.7);
      store.addCommunity("comm-2", runId, "Media", "Media community", 0.5);
      store.addCommunityOverlap("comm-1", "comm-2", runId, 0.3);

      // Actors
      const actor1 = uuid();
      const actor2 = uuid();
      store.addActor({
        id: actor1,
        run_id: runId,
        entity_id: null,
        archetype: "persona",
        cognition_tier: "B",
        name: "Student Leader",
        handle: "@student_leader",
        personality: "activist",
        bio: null,
        age: 22,
        gender: "female",
        profession: "student",
        region: "Bogota",
        language: "es",
        stance: "opposing",
        sentiment_bias: -0.5,
        activity_level: 0.8,
        influence_weight: 0.7,
        community_id: "comm-1",
        active_hours: JSON.stringify([9, 10, 11, 19, 20, 21]),
        follower_count: 500,
        following_count: 200,
      });
      store.addActor({
        id: actor2,
        run_id: runId,
        entity_id: null,
        archetype: "media",
        cognition_tier: "A",
        name: "News Outlet",
        handle: "@news",
        personality: "objective reporter",
        bio: null,
        age: null,
        gender: null,
        profession: null,
        region: "Bogota",
        language: "es",
        stance: "neutral",
        sentiment_bias: 0,
        activity_level: 0.9,
        influence_weight: 0.9,
        community_id: "comm-2",
        active_hours: JSON.stringify([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]),
        follower_count: 10000,
        following_count: 500,
      });

      // Follows
      store.addFollow({
        follower_id: actor1,
        following_id: actor2,
        run_id: runId,
        since_round: 0,
      });

      // Posts with topics
      const postId = uuid();
      store.addPost({
        id: postId,
        run_id: runId,
        author_id: actor1,
        content: "The tuition increase is unacceptable!",
        round_num: 1,
        sim_timestamp: "2024-01-01T09:00:00",
        likes: 15,
        reposts: 5,
        comments: 3,
        reach: 50,
        sentiment: -0.8,
      });
      store.addPostTopic(postId, "tuition");
      store.addPostTopic(postId, "protest");

      const state = store.buildPlatformState(runId, 2, 5);

      // Verify structure
      expect(state.runId).toBe(runId);
      expect(state.recentPosts).toHaveLength(1);
      expect(state.recentPosts[0].topics).toContain("tuition");
      expect(state.recentPosts[0].topics).toContain("protest");
      expect(state.recentPosts[0].authorId).toBe(actor1);

      // Follow graph
      expect(state.followGraph.get(actor1)).toContain(actor2);

      // Engagement
      expect(state.engagementByPost.get(postId)!.likes).toBe(15);

      // Actor snapshots
      expect(state.actors.get(actor1)!.stance).toBe("opposing");
      expect(state.actors.get(actor2)!.influenceWeight).toBe(0.9);

      // Communities
      expect(state.communities).toHaveLength(2);
      const studentComm = state.communities.find((c) => c.id === "comm-1")!;
      expect(studentComm.cohesion).toBe(0.7);
      expect(studentComm.memberIds).toContain(actor1);
      expect(studentComm.overlaps.get("comm-2")).toBe(0.3);
    });
  });

  // ─── Run manifest + snapshots ───

  describe("run manifest", () => {
    it("creates and updates runs", () => {
      const runId = uuid();
      store.createRun({
        id: runId,
        started_at: new Date().toISOString(),
        seed: 42,
        config_snapshot: '{"test": true}',
        graph_revision_id: "rev-1",
        status: "running",
        version: "0.1.0",
      });

      let run = store.getRun(runId);
      expect(run).not.toBeNull();
      expect(run!.status).toBe("running");
      expect(run!.seed).toBe(42);

      store.updateRun(runId, {
        status: "completed",
        finished_at: new Date().toISOString(),
        total_rounds: 5,
      });

      run = store.getRun(runId);
      expect(run!.status).toBe("completed");
      expect(run!.total_rounds).toBe(5);
    });
  });

  describe("replay scaffolds", () => {
    it("captures and restores a run scaffold", () => {
      const runId = "run-scaffold";
      store.createRun({
        id: runId,
        started_at: "2024-01-01T00:00:00",
        seed: 42,
        config_snapshot: "{}",
        graph_revision_id: "rev-scaffold",
        status: "paused",
      });
      store.addActor({
        id: "actor-scaffold",
        run_id: runId,
        entity_id: null,
        archetype: "persona",
        cognition_tier: "B",
        name: "Scaffold Actor",
        handle: "@scaffold",
        personality: "A scaffold actor",
        bio: null,
        age: 30,
        gender: null,
        profession: null,
        region: null,
        language: "es",
        stance: "neutral",
        sentiment_bias: 0,
        activity_level: 0.5,
        influence_weight: 0.5,
        community_id: null,
        active_hours: null,
        follower_count: 50,
        following_count: 10,
      });
      store.addActorTopic("actor-scaffold", "education", 0.9);
      store.addActorBelief("actor-scaffold", "education", 0.3, 0);
      store.addCommunity("community-1", runId, "community-1", "test", 0.5);
      store.updateActorCommunity("actor-scaffold", "community-1");
      store.addPost({
        id: "seed-post-1",
        run_id: runId,
        author_id: "actor-scaffold",
        content: "Seed post",
        round_num: 0,
        sim_timestamp: "2024-01-01T00:00:00",
        likes: 0,
        reposts: 0,
        comments: 0,
        reach: 0,
        sentiment: 0.1,
      });
      store.addPostTopic("seed-post-1", "education");

      const scaffold = store.captureRunScaffold(runId);
      expect(scaffold.actors).toHaveLength(1);
      expect(scaffold.posts).toHaveLength(1);

      store.saveRunScaffold(runId, scaffold);
      store.resetRunToScaffold(runId);

      expect(store.getActorsByRun(runId)).toHaveLength(1);
      expect(store.getRunScaffold(runId)?.posts).toHaveLength(1);
    });
  });

  describe("decision traces", () => {
    it("persists and lists decision traces", () => {
      const runId = "run-trace";
      store.createRun({
        id: runId,
        started_at: "2024-01-01T00:00:00",
        seed: 42,
        config_snapshot: "{}",
        graph_revision_id: "rev-trace",
        status: "running",
      });
      store.addActor({
        id: "actor-trace",
        run_id: runId,
        entity_id: null,
        archetype: "persona",
        cognition_tier: "B",
        name: "Trace Actor",
        handle: "@trace",
        personality: "A trace actor",
        bio: null,
        age: null,
        gender: null,
        profession: null,
        region: null,
        language: "es",
        stance: "neutral",
        sentiment_bias: 0,
        activity_level: 0.5,
        influence_weight: 0.5,
        community_id: null,
        active_hours: null,
        follower_count: 10,
        following_count: 5,
      });

      store.logDecisionTrace({
        id: "trace-1",
        run_id: runId,
        round_num: 1,
        actor_id: "actor-trace",
        route_tier: "B",
        route_reason: "random sampling",
        search_eligible: 1,
        search_selected: 1,
        final_action: "post",
      });

      const traces = store.listDecisionTraces(runId, "actor-trace");
      expect(traces).toHaveLength(1);
      expect(traces[0].route_reason).toBe("random sampling");
      expect(traces[0].final_action).toBe("post");
    });
  });

  describe("snapshots", () => {
    it("saves and retrieves latest snapshot", () => {
      const runId = uuid();
      store.createRun({
        id: runId,
        started_at: new Date().toISOString(),
        seed: 42,
        config_snapshot: "{}",
        graph_revision_id: "rev-1",
        status: "running",
      });

      store.saveSnapshot({
        id: uuid(),
        run_id: runId,
        round_num: 5,
        actor_states: '{"actors":[]}',
        narrative_states: '{"narratives":[]}',
        rng_state: "rng-state-5",
      });

      store.saveSnapshot({
        id: uuid(),
        run_id: runId,
        round_num: 10,
        actor_states: '{"actors":["updated"]}',
        narrative_states: '{"narratives":["updated"]}',
        rng_state: "rng-state-10",
      });

      const latest = store.getLatestSnapshot(runId);
      expect(latest).not.toBeNull();
      expect(latest!.round_num).toBe(10);
      expect(latest!.rng_state).toBe("rng-state-10");
    });
  });

  // ─── Graph revision ID ───

  describe("computeGraphRevisionId", () => {
    it("is deterministic for the same graph state", () => {
      store.addEntityType({ name: "person", description: "A person" });
      store.addEntity({ id: "e1", type: "person", name: "Alice" });
      store.addEntity({ id: "e2", type: "person", name: "Bob" });

      const rev1 = store.computeGraphRevisionId();
      const rev2 = store.computeGraphRevisionId();
      expect(rev1).toBe(rev2);
      expect(rev1).toHaveLength(64); // SHA-256 hex
    });
  });

  // ─── Telemetry + Rounds ───

  describe("telemetry and rounds", () => {
    it("logs telemetry and upserts rounds", () => {
      const runId = uuid();
      store.createRun({
        id: runId,
        started_at: new Date().toISOString(),
        seed: 42,
        config_snapshot: "{}",
        graph_revision_id: "rev-1",
        status: "running",
      });

      store.logTelemetry({
        run_id: runId,
        round_num: 1,
        actor_id: "actor-1",
        cognition_tier: "A",
        action_type: "post",
        tokens_input: 500,
        tokens_output: 100,
        cost_usd: 0.002,
        duration_ms: 350,
        provider: "claude-haiku-4",
      });

      const telemetry = store.db
        .prepare(`SELECT * FROM telemetry WHERE run_id = ?`)
        .all(runId);
      expect(telemetry).toHaveLength(1);

      store.upsertRound({
        num: 1,
        run_id: runId,
        sim_time: "2024-01-01T09:00:00",
        active_actors: 10,
        total_posts: 5,
        tier_a_calls: 3,
        tier_b_calls: 2,
        tier_c_actions: 5,
      });

      // Upsert again (update)
      store.upsertRound({
        num: 1,
        run_id: runId,
        wall_time_ms: 1500,
      });

      const round = store.db
        .prepare(`SELECT * FROM rounds WHERE num = 1 AND run_id = ?`)
        .get(runId) as { active_actors: number; wall_time_ms: number };
      expect(round.active_actors).toBe(10);
      expect(round.wall_time_ms).toBe(1500);
    });
  });

  // ═══════════════════════════════════════
  // REGRESSION TESTS for audit findings
  // ═══════════════════════════════════════

  describe("regression: community run isolation", () => {
    it("buildPlatformState only returns communities for the given run", () => {
      const run1 = uuid();
      const run2 = uuid();

      store.createRun({
        id: run1,
        started_at: new Date().toISOString(),
        seed: 1,
        config_snapshot: "{}",
        graph_revision_id: "rev-1",
        status: "running",
      });
      store.createRun({
        id: run2,
        started_at: new Date().toISOString(),
        seed: 2,
        config_snapshot: "{}",
        graph_revision_id: "rev-1",
        status: "running",
      });

      // Communities for run1
      store.addCommunity("comm-r1", run1, "Run1 Community", undefined, 0.8);

      // Communities for run2
      store.addCommunity("comm-r2", run2, "Run2 Community", undefined, 0.6);

      // Actors for run1
      store.addActor({
        id: "actor-r1",
        run_id: run1,
        entity_id: null,
        archetype: "persona",
        cognition_tier: "B",
        name: "Run1 Actor",
        handle: null,
        personality: "test",
        bio: null,
        age: null,
        gender: null,
        profession: null,
        region: null,
        language: "es",
        stance: "neutral",
        sentiment_bias: 0,
        activity_level: 0.5,
        influence_weight: 0.5,
        community_id: "comm-r1",
        active_hours: null,
        follower_count: 100,
        following_count: 50,
      });

      const state1 = store.buildPlatformState(run1, 1, 5);
      const state2 = store.buildPlatformState(run2, 1, 5);

      // run1 should only see comm-r1
      expect(state1.communities.map((c) => c.id)).toContain("comm-r1");
      expect(state1.communities.map((c) => c.id)).not.toContain("comm-r2");

      // run2 should only see comm-r2
      expect(state2.communities.map((c) => c.id)).toContain("comm-r2");
      expect(state2.communities.map((c) => c.id)).not.toContain("comm-r1");
    });
  });

  describe("regression: merged entity exclusion", () => {
    it("searchEntities excludes absorbed entities", () => {
      store.addEntityType({ name: "person", description: "A person" });
      const alice = store.addEntity({
        id: uuid(),
        type: "person",
        name: "Alice Johnson",
      });
      const aliceAlt = store.addEntity({
        id: uuid(),
        type: "person",
        name: "A. Johnson",
      });

      // Both should be findable before merge
      const before = store.searchEntities("Johnson");
      expect(before).toHaveLength(2);

      // Merge aliceAlt into alice
      store.mergeEntities(alice, aliceAlt, 0.95, "name_similarity");

      // After merge, only alice should appear
      const after = store.searchEntities("Johnson");
      expect(after).toHaveLength(1);
      expect(after[0].id).toBe(alice);
    });

    it("computeGraphRevisionId excludes absorbed entities", () => {
      store.addEntityType({ name: "org", description: "Org" });
      const a = store.addEntity({ id: uuid(), type: "org", name: "Org A" });
      const b = store.addEntity({ id: uuid(), type: "org", name: "Org B" });

      const revBefore = store.computeGraphRevisionId();

      store.mergeEntities(a, b, 0.9, "manual");

      const revAfter = store.computeGraphRevisionId();

      // Revision should change after merge (fewer active entities)
      expect(revAfter).not.toBe(revBefore);
    });
  });
});
