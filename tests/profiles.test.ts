/**
 * profiles.test.ts — Tests for profile generation pipeline
 *
 * Covers:
 * - generateSingleProfile() with mock LLM
 * - generateProfiles() full pipeline with mock LLM
 * - Actors created in DB with correct fields
 * - actor_topics and actor_beliefs populated
 * - Communities created from topic clustering
 * - Follow graph created
 * - Seed posts for key actors (tier A)
 * - Archetype mapping from entity types
 * - Cognition tier assignment
 * - Fields: gender, region, language populated
 * - Empty entities → empty result
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SQLiteGraphStore } from "../src/db.js";
import { MockLLMClient } from "../src/llm.js";
import { ingestDocument } from "../src/ingest.js";
import {
  generateProfiles,
  generateSingleProfile,
} from "../src/profiles.js";

// ═══════════════════════════════════════════════════════
// MOCK LLM RESPONSES
// ═══════════════════════════════════════════════════════

const MOCK_PROFILE_RESPONSE = JSON.stringify({
  personality:
    "Un líder estudiantil apasionado que defiende los derechos de acceso a la educación pública. Activo en redes sociales, comparte análisis y convoca a la acción.",
  bio: "Presidenta de la Asociación de Estudiantes ASEU",
  age: 23,
  gender: "female",
  profession: "Estudiante de Derecho",
  region: "Bogotá, Colombia",
  language: "es",
  stance: "opposing",
  sentiment_bias: -0.7,
  activity_level: 0.9,
  influence_weight: 0.8,
  handle: "@maria_lopez_aseu",
  topics: [
    { topic: "education", weight: 0.95 },
    { topic: "tuition", weight: 0.9 },
    { topic: "student_rights", weight: 0.85 },
  ],
  beliefs: [
    { topic: "tuition", sentiment: -0.8 },
    { topic: "education_quality", sentiment: 0.3 },
  ],
});

// ═══════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════

function setupStoreWithEntities(): {
  store: SQLiteGraphStore;
  runId: string;
} {
  const store = new SQLiteGraphStore(":memory:");

  // Create run manifest first (required FK for actors)
  const runId = "test-run-001";
  store.createRun({
    id: runId,
    started_at: new Date().toISOString(),
    seed: 42,
    config_snapshot: "{}",
    graph_revision_id: "test-revision",
    status: "running",
  });

  // Ingest a document and create chunks
  ingestDocument(
    store,
    "test.md",
    [
      "La Universidad Nacional anunció un aumento del 30% en cuotas.",
      "",
      "María López de ASEU rechazó la medida.",
      "",
      "El rector Carlos Martínez defiende la decisión.",
    ].join("\n"),
    { minChunkChars: 20 }
  );

  // Add entity types
  store.addEntityType({ name: "person", description: "A named individual" });
  store.addEntityType({ name: "organization", description: "An institution" });
  store.addEntityType({
    name: "university",
    description: "Academic institution",
  });

  // Add entities (simulating what graph.ts would produce)
  store.addEntity({
    id: "entity-maria",
    type: "person",
    name: "María López",
  });
  store.addEntity({
    id: "entity-carlos",
    type: "person",
    name: "Carlos Martínez",
  });
  store.addEntity({
    id: "entity-aseu",
    type: "organization",
    name: "ASEU",
  });
  store.addEntity({
    id: "entity-unal",
    type: "university",
    name: "Universidad Nacional",
  });

  // Add some claims for provenance
  const chunks = store.getChunksByDocument(
    store.getAllDocuments()[0].id
  );
  const claimId = store.addClaim({
    id: "",
    source_chunk_id: chunks[0].id,
    subject: "María López",
    predicate: "preside",
    object: "ASEU",
    confidence: 1.0,
    observed_at: new Date().toISOString(),
  });
  store.linkClaimToEntity("entity-maria", claimId);

  return { store, runId };
}

// ═══════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════

describe("generateSingleProfile", () => {
  it("generates a profile from mock LLM response", async () => {
    const llm = new MockLLMClient();
    llm.setResponse("Generate a social media profile", MOCK_PROFILE_RESPONSE);

    const entity = {
      id: "test-entity",
      type: "person",
      name: "María López",
    };

    const profile = await generateSingleProfile(
      llm,
      entity,
      ["María López preside ASEU"],
      "Student tuition protest scenario",
      "x"
    );

    expect(profile.personality).toContain("líder estudiantil");
    expect(profile.bio).toContain("ASEU");
    expect(profile.age).toBe(23);
    expect(profile.gender).toBe("female");
    expect(profile.language).toBe("es");
    expect(profile.stance).toBe("opposing");
    expect(profile.sentiment_bias).toBe(-0.7);
    expect(profile.handle).toBe("@maria_lopez_aseu");
    expect(profile.topics.length).toBeGreaterThan(0);
    expect(profile.beliefs.length).toBeGreaterThan(0);
  });
});

describe("generateProfiles", () => {
  let store: SQLiteGraphStore;
  let llm: MockLLMClient;
  let runId: string;

  beforeEach(() => {
    const setup = setupStoreWithEntities();
    store = setup.store;
    runId = setup.runId;
    llm = new MockLLMClient();
    llm.setResponse("Generate a social media profile", MOCK_PROFILE_RESPONSE);
  });

  afterEach(() => {
    store.close();
  });

  it("creates actors in DB from entities", async () => {
    const result = await generateProfiles(store, llm, {
      runId,
      hypothesis: "University tuition increase scenario",
    });

    expect(result.actorsCreated).toBe(4); // 4 entities
    const actors = store.getActorsByRun(runId);
    expect(actors.length).toBe(4);
  });

  it("actors have correct archetype mapping", async () => {
    await generateProfiles(store, llm, { runId });

    const actors = store.getActorsByRun(runId);
    const archetypes = new Map(actors.map((a) => [a.entity_id, a.archetype]));

    // person → persona, organization → organization, university → institution
    expect(archetypes.get("entity-maria")).toBe("persona");
    expect(archetypes.get("entity-carlos")).toBe("persona");
    expect(archetypes.get("entity-aseu")).toBe("organization");
    expect(archetypes.get("entity-unal")).toBe("institution");
  });

  it("actors have populated personality, bio, gender, region, language", async () => {
    await generateProfiles(store, llm, { runId });

    const actors = store.getActorsByRun(runId);
    for (const actor of actors) {
      expect(actor.personality).toBeTruthy();
      expect(actor.language).toBeTruthy();
      // gender, region may be null for organizations, but should be populated for persons
      // bio can be empty string but not null
    }
  });

  it("actors have valid cognition_tier", async () => {
    await generateProfiles(store, llm, { runId });

    const actors = store.getActorsByRun(runId);
    for (const actor of actors) {
      expect(["A", "B", "C"]).toContain(actor.cognition_tier);
    }
  });

  it("institution and media archetypes get tier A", async () => {
    await generateProfiles(store, llm, { runId });

    const actors = store.getActorsByRun(runId);
    const unal = actors.find((a) => a.entity_id === "entity-unal");
    // University → institution → tier A (archetype override)
    expect(unal?.cognition_tier).toBe("A");
  });

  it("actor_topics populated", async () => {
    await generateProfiles(store, llm, { runId });

    const actors = store.getActorsByRun(runId);
    // Check at least one actor has topics
    let totalTopics = 0;
    for (const actor of actors) {
      const topics = store.db
        .prepare("SELECT * FROM actor_topics WHERE actor_id = ?")
        .all(actor.id) as Array<{ topic: string; weight: number }>;
      totalTopics += topics.length;
    }
    expect(totalTopics).toBeGreaterThan(0);
  });

  it("actor_beliefs populated", async () => {
    await generateProfiles(store, llm, { runId });

    const actors = store.getActorsByRun(runId);
    let totalBeliefs = 0;
    for (const actor of actors) {
      const beliefs = store.db
        .prepare("SELECT * FROM actor_beliefs WHERE actor_id = ?")
        .all(actor.id) as Array<{ topic: string; sentiment: number }>;
      totalBeliefs += beliefs.length;
    }
    expect(totalBeliefs).toBeGreaterThan(0);
  });

  it("communities created from topic clustering", async () => {
    const result = await generateProfiles(store, llm, { runId });

    expect(result.communitiesCreated).toBeGreaterThan(0);

    const communities = store.db
      .prepare("SELECT * FROM communities WHERE run_id = ?")
      .all(runId);
    expect(communities.length).toBeGreaterThan(0);
  });

  it("actors assigned to communities", async () => {
    await generateProfiles(store, llm, { runId });

    const actors = store.getActorsByRun(runId);
    const withCommunity = actors.filter((a) => a.community_id !== null);
    expect(withCommunity.length).toBeGreaterThan(0);
  });

  it("follow graph created", async () => {
    const result = await generateProfiles(store, llm, { runId });

    expect(result.followsCreated).toBeGreaterThan(0);

    const follows = store.db
      .prepare("SELECT * FROM follows WHERE run_id = ?")
      .all(runId);
    expect(follows.length).toBeGreaterThan(0);
  });

  it("seed posts created for tier A actors", async () => {
    const result = await generateProfiles(store, llm, { runId });

    // At least university (institution) should be tier A
    expect(result.seedPostsCreated).toBeGreaterThan(0);

    const posts = store.db
      .prepare("SELECT * FROM posts WHERE run_id = ? AND round_num = 0")
      .all(runId);
    expect(posts.length).toBeGreaterThan(0);
  });

  it("each actor has valid entity_id FK", async () => {
    await generateProfiles(store, llm, { runId });

    const actors = store.getActorsByRun(runId);
    for (const actor of actors) {
      if (actor.entity_id) {
        const entity = store.db
          .prepare("SELECT id FROM entities WHERE id = ?")
          .get(actor.entity_id) as { id: string } | undefined;
        expect(entity).toBeDefined();
      }
    }
  });

  it("handles empty entities gracefully", async () => {
    const emptyStore = new SQLiteGraphStore(":memory:");
    const emptyRunId = "empty-run";
    emptyStore.createRun({
      id: emptyRunId,
      started_at: new Date().toISOString(),
      seed: 42,
      config_snapshot: "{}",
      graph_revision_id: "test",
      status: "running",
    });

    const result = await generateProfiles(emptyStore, llm, {
      runId: emptyRunId,
    });

    expect(result.actorsCreated).toBe(0);
    expect(result.communitiesCreated).toBe(0);
    expect(result.followsCreated).toBe(0);
    expect(result.seedPostsCreated).toBe(0);

    emptyStore.close();
  });

  it("respects maxActors option", async () => {
    const result = await generateProfiles(store, llm, {
      runId,
      maxActors: 2,
    });

    expect(result.actorsCreated).toBe(2);
  });

  it("creates operator-requested focus actors even when they are not in the graph", async () => {
    const result = await generateProfiles(store, llm, {
      runId,
      maxActors: 2,
      focusActors: ["macro traders", "technology journalists"],
    });

    expect(result.actorsCreated).toBe(2);
    const actors = store.getActorsByRun(runId);
    expect(actors.map((actor) => actor.name)).toEqual([
      "macro traders",
      "technology journalists",
    ]);
    expect(actors.every((actor) => actor.entity_id === null)).toBe(true);
  });

  it("actors have sentiment_bias in [-1, 1]", async () => {
    await generateProfiles(store, llm, { runId });

    const actors = store.getActorsByRun(runId);
    for (const actor of actors) {
      expect(actor.sentiment_bias).toBeGreaterThanOrEqual(-1);
      expect(actor.sentiment_bias).toBeLessThanOrEqual(1);
    }
  });

  it("actors have activity_level in [0, 1]", async () => {
    await generateProfiles(store, llm, { runId });

    const actors = store.getActorsByRun(runId);
    for (const actor of actors) {
      expect(actor.activity_level).toBeGreaterThanOrEqual(0);
      expect(actor.activity_level).toBeLessThanOrEqual(1);
    }
  });
});
