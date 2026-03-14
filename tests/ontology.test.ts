/**
 * ontology.test.ts — Tests for ontology extraction pipeline
 *
 * Covers:
 * - normalizeTypeName() normalization
 * - discoverSchema() with mock LLM
 * - extractClaims() with mock LLM
 * - extractOntology() full pipeline with mock LLM
 * - entity_types and edge_types persisted to DB
 * - claims persisted with valid source_chunk_id FK
 * - claims have confidence, topics, valid_from/valid_to
 * - Empty chunks → empty result (no crash)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SQLiteGraphStore } from "../src/db.js";
import { MockLLMClient } from "../src/llm.js";
import { ingestDocument } from "../src/ingest.js";
import {
  extractOntology,
  discoverSchema,
  extractClaims,
  normalizeTypeName,
} from "../src/ontology.js";

// ═══════════════════════════════════════════════════════
// MOCK RESPONSES
// ═══════════════════════════════════════════════════════

const MOCK_SCHEMA_RESPONSE = JSON.stringify({
  entity_types: [
    {
      name: "person",
      description: "A named individual",
      attributes: ["name", "role", "affiliation"],
    },
    {
      name: "organization",
      description: "An institution or entity",
      attributes: ["name", "type", "location"],
    },
    {
      name: "university",
      description: "An academic institution",
      attributes: ["name", "location", "type"],
    },
  ],
  edge_types: [
    {
      name: "works_at",
      description: "Employment relationship",
      source_type: "person",
      target_type: "organization",
    },
    {
      name: "opposes",
      description: "Opposition to a decision or entity",
      source_type: "person",
      target_type: "organization",
    },
  ],
});

const MOCK_CLAIMS_RESPONSE = JSON.stringify({
  claims: [
    {
      subject: "Universidad Nacional",
      predicate: "anuncia aumento",
      object: "cuotas 30%",
      confidence: 0.95,
      valid_from: "2025-03-15",
      valid_to: null,
      topics: ["education", "tuition"],
    },
    {
      subject: "Carlos Martínez",
      predicate: "es rector de",
      object: "Universidad Nacional",
      confidence: 1.0,
      valid_from: null,
      valid_to: null,
      topics: ["education", "leadership"],
    },
    {
      subject: "ASEU",
      predicate: "rechaza",
      object: "aumento de cuotas",
      confidence: 0.9,
      valid_from: "2025-03-15",
      valid_to: null,
      topics: ["education", "protest"],
    },
  ],
});

// ═══════════════════════════════════════════════════════
// HELPER: set up store with ingested documents
// ═══════════════════════════════════════════════════════

function setupStoreWithChunks(): SQLiteGraphStore {
  const store = new SQLiteGraphStore(":memory:");

  ingestDocument(
    store,
    "test-doc.md",
    [
      "# Universidad Nacional anuncia aumento de cuotas",
      "",
      "La Universidad Nacional de Colombia anunció un aumento del 30% en las cuotas de matrícula. La decisión fue tomada por el Consejo Superior Universitario.",
      "",
      "El rector Carlos Martínez declaró que el aumento es necesario para mantener la calidad académica. La inversión en infraestructura requiere recursos adicionales.",
      "",
      "La Asociación de Estudiantes ASEU rechazó la medida y convocó asambleas en todas las facultades. Su presidenta María López calificó el aumento como desproporcionado.",
    ].join("\n"),
    { minChunkChars: 30 }
  );

  return store;
}

// ═══════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════

describe("normalizeTypeName", () => {
  it("converts to lowercase snake_case", () => {
    expect(normalizeTypeName("Person")).toBe("person");
    expect(normalizeTypeName("Media Outlet")).toBe("media_outlet");
    expect(normalizeTypeName("Government Body")).toBe("government_body");
  });

  it("removes special characters", () => {
    expect(normalizeTypeName("person-type")).toBe("persontype");
    expect(normalizeTypeName("org.type")).toBe("orgtype");
  });

  it("handles extra whitespace", () => {
    // trim() first, then \s+ → _, so "  some  type  " → "some_type"
    expect(normalizeTypeName("  some  type  ")).toBe("some_type");
  });
});

describe("discoverSchema", () => {
  it("extracts entity types and edge types from LLM response", async () => {
    const llm = new MockLLMClient();
    llm.setResponse("Analyze the following", MOCK_SCHEMA_RESPONSE);

    const result = await discoverSchema(llm, [
      "Some text about a university and its actors.",
    ]);

    expect(result.entityTypes.length).toBe(3);
    expect(result.edgeTypes.length).toBe(2);

    // Check entity type structure
    const person = result.entityTypes.find((et) => et.name === "person");
    expect(person).toBeDefined();
    expect(person!.description).toBe("A named individual");
    const attrs = JSON.parse(person!.attributes!);
    expect(attrs).toContain("name");
    expect(attrs).toContain("role");

    // Check edge type structure
    const worksAt = result.edgeTypes.find((et) => et.name === "works_at");
    expect(worksAt).toBeDefined();
    expect(worksAt!.source_type).toBe("person");
    expect(worksAt!.target_type).toBe("organization");
  });
});

describe("extractClaims", () => {
  it("extracts claims from LLM response", async () => {
    const llm = new MockLLMClient();
    llm.setResponse("Extract all factual claims", MOCK_CLAIMS_RESPONSE);

    const claims = await extractClaims(
      llm,
      ["Some text about the university."],
      ["person", "organization"]
    );

    expect(claims.length).toBe(3);

    const tuitionClaim = claims.find((c) => c.subject === "Universidad Nacional");
    expect(tuitionClaim).toBeDefined();
    expect(tuitionClaim!.predicate).toBe("anuncia aumento");
    expect(tuitionClaim!.object).toBe("cuotas 30%");
    expect(tuitionClaim!.confidence).toBe(0.95);
    expect(tuitionClaim!.valid_from).toBe("2025-03-15");
    expect(tuitionClaim!.topics).toContain("education");
    expect(tuitionClaim!.topics).toContain("tuition");
  });
});

describe("extractOntology", () => {
  let store: SQLiteGraphStore;
  let llm: MockLLMClient;

  beforeEach(() => {
    store = setupStoreWithChunks();
    llm = new MockLLMClient();
    // Set up mock responses for both LLM calls
    llm.setResponse("Analyze the following", MOCK_SCHEMA_RESPONSE);
    llm.setResponse("Extract all factual claims", MOCK_CLAIMS_RESPONSE);
  });

  afterEach(() => {
    store.close();
  });

  it("full pipeline: creates entity_types, edge_types, and claims in DB", async () => {
    const result = await extractOntology(store, llm);

    // Entity types persisted
    expect(result.entityTypes.length).toBe(3);
    const etRows = store.db
      .prepare("SELECT * FROM entity_types")
      .all() as Array<{ name: string }>;
    expect(etRows.length).toBe(3);
    expect(etRows.map((r) => r.name)).toContain("person");
    expect(etRows.map((r) => r.name)).toContain("organization");

    // Edge types persisted
    expect(result.edgeTypes.length).toBe(2);
    const edgeRows = store.db
      .prepare("SELECT * FROM edge_types")
      .all() as Array<{ name: string }>;
    expect(edgeRows.length).toBe(2);

    // Claims persisted
    expect(result.claimsExtracted).toBeGreaterThan(0);
    const claimRows = store.db
      .prepare("SELECT * FROM claims")
      .all() as Array<{
        id: string;
        source_chunk_id: string;
        subject: string;
        predicate: string;
        object: string;
        confidence: number;
        topics: string | null;
      }>;
    expect(claimRows.length).toBeGreaterThan(0);
  });

  it("every claim has valid source_chunk_id FK", async () => {
    await extractOntology(store, llm);

    const claimRows = store.db
      .prepare("SELECT * FROM claims")
      .all() as Array<{ source_chunk_id: string }>;

    for (const claim of claimRows) {
      const chunk = store.db
        .prepare("SELECT id FROM chunks WHERE id = ?")
        .get(claim.source_chunk_id) as { id: string } | undefined;
      expect(chunk).toBeDefined();
    }
  });

  it("claims have confidence values in [0.0, 1.0]", async () => {
    await extractOntology(store, llm);

    const claimRows = store.db
      .prepare("SELECT confidence FROM claims")
      .all() as Array<{ confidence: number }>;

    for (const claim of claimRows) {
      expect(claim.confidence).toBeGreaterThanOrEqual(0.0);
      expect(claim.confidence).toBeLessThanOrEqual(1.0);
    }
  });

  it("claims have topics as JSON array when present", async () => {
    await extractOntology(store, llm);

    const claimRows = store.db
      .prepare("SELECT topics FROM claims WHERE topics IS NOT NULL")
      .all() as Array<{ topics: string }>;

    expect(claimRows.length).toBeGreaterThan(0);
    for (const claim of claimRows) {
      const topics = JSON.parse(claim.topics);
      expect(Array.isArray(topics)).toBe(true);
      expect(topics.length).toBeGreaterThan(0);
    }
  });

  it("claims have valid_from when temporal info exists", async () => {
    await extractOntology(store, llm);

    const claimRows = store.db
      .prepare("SELECT valid_from FROM claims WHERE valid_from IS NOT NULL")
      .all() as Array<{ valid_from: string }>;

    expect(claimRows.length).toBeGreaterThan(0);
    for (const claim of claimRows) {
      // Should be a valid date-like string
      expect(claim.valid_from).toMatch(/^\d{4}-\d{2}-\d{2}/);
    }
  });

  it("handles empty chunks (no documents) gracefully", async () => {
    const emptyStore = new SQLiteGraphStore(":memory:");
    const result = await extractOntology(emptyStore, llm);

    expect(result.entityTypes.length).toBe(0);
    expect(result.edgeTypes.length).toBe(0);
    expect(result.claimsExtracted).toBe(0);
    expect(result.chunksProcessed).toBe(0);

    emptyStore.close();
  });

  it("respects maxClaimsChunks option", async () => {
    const result = await extractOntology(store, llm, {
      maxClaimsChunks: 1,
    });

    expect(result.chunksProcessed).toBe(1);
    // Should still have entity/edge types from full schema discovery
    expect(result.entityTypes.length).toBe(3);
  });

  it("chunksProcessed matches actual chunks in DB", async () => {
    const result = await extractOntology(store, llm);

    const allDocs = store.getAllDocuments();
    let totalChunks = 0;
    for (const doc of allDocs) {
      totalChunks += store.getChunksByDocument(doc.id).length;
    }

    expect(result.chunksProcessed).toBe(totalChunks);
  });
});
