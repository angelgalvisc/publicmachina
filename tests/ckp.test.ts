/**
 * ckp.test.ts — Tests for CKP export/import module
 *
 * Covers scrubSecrets, exportAgent, importAgent.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { SQLiteGraphStore } from "../src/db.js";
import { scrubSecrets, scrubSecretsInText, exportAgent, importAgent } from "../src/ckp.js";

// ═══════════════════════════════════════════════════════
// TEST HELPERS
// ═══════════════════════════════════════════════════════

function setupTestStore(): {
  store: SQLiteGraphStore;
  runId: string;
  actorId: string;
} {
  const store = new SQLiteGraphStore(":memory:");
  const runId = "test-run";
  store.createRun({
    id: runId,
    started_at: new Date().toISOString(),
    seed: 42,
    config_snapshot: "{}",
    graph_revision_id: "test",
    status: "completed",
    total_rounds: 10,
  });
  const actorId = "actor-1";
  store.addActor({
    id: actorId,
    run_id: runId,
    entity_id: null,
    archetype: "persona",
    cognition_tier: "A",
    name: "Test Actor",
    handle: "testactor",
    personality: "A curious researcher who values data. Backup key sk-secret123. Auth header Bearer tok_abc.",
    bio: "Test bio",
    age: 30,
    gender: "non-binary",
    profession: "researcher",
    region: "US",
    language: "en",
    stance: "neutral",
    sentiment_bias: 0.1,
    activity_level: 0.7,
    influence_weight: 0.5,
    community_id: null,
    active_hours: JSON.stringify([9, 10, 11, 14, 15, 16]),
    follower_count: 100,
    following_count: 50,
  });
  store.addActorBelief(actorId, "education", 0.3);
  store.addActorBelief(actorId, "climate", -0.5);
  store.addActorTopic(actorId, "education", 0.8);
  store.addActorTopic(actorId, "climate", 0.6);
  return { store, runId, actorId };
}

// ═══════════════════════════════════════════════════════
// TEMP DIR MANAGEMENT
// ═══════════════════════════════════════════════════════

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ckp-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true });
    }
  }
  tempDirs.length = 0;
});

// ═══════════════════════════════════════════════════════
// scrubSecrets
// ═══════════════════════════════════════════════════════

describe("scrubSecrets", () => {
  it("redacts API key values", () => {
    const input = { apiKey: "sk-12345" };
    const result = scrubSecrets(input);
    expect(result.apiKey).toBe("[REDACTED]");
  });

  it("redacts nested secret keys", () => {
    const input = { config: { token: "abc123", name: "safe" } };
    const result = scrubSecrets(input);
    expect(result.config.token).toBe("[REDACTED]");
    expect(result.config.name).toBe("safe");
  });

  it("does not mutate original", () => {
    const input = { apiKey: "sk-12345", nested: { secret: "value" } };
    const original = JSON.parse(JSON.stringify(input));
    scrubSecrets(input);
    expect(input).toEqual(original);
  });

  it("redacts string values with known prefixes", () => {
    const input = { value: "sk-abcdef1234567890abcdefgh" };
    const result = scrubSecrets(input);
    expect(result.value).toBe("[REDACTED]");
  });

  it("passes through safe values unchanged", () => {
    const input = { name: "test", count: 42 };
    const result = scrubSecrets(input);
    expect(result).toEqual({ name: "test", count: 42 });
  });

  it("redacts known secret patterns in plain text", () => {
    const text = "Use token sk-secret123 and header Bearer abc.def";
    expect(scrubSecretsInText(text)).toContain("[REDACTED]");
    expect(scrubSecretsInText(text)).not.toContain("sk-secret123");
    expect(scrubSecretsInText(text)).not.toContain("Bearer abc.def");
  });
});

// ═══════════════════════════════════════════════════════
// exportAgent
// ═══════════════════════════════════════════════════════

describe("exportAgent", () => {
  it("generates all expected files", () => {
    const { store, runId, actorId } = setupTestStore();
    const outDir = join(makeTempDir(), "export");

    const result = exportAgent(store, runId, actorId, outDir);

    expect(result.files).toHaveLength(7);
    const expectedFiles = [
      "claw.yaml",
      "actor_state.json",
      "beliefs.json",
      "topics.json",
      "provenance.json",
      "persona.md",
      "manifest.meta.json",
    ];
    for (const file of expectedFiles) {
      expect(existsSync(join(outDir, file))).toBe(true);
    }
    expect(result.actorId).toBe(actorId);
    expect(result.outDir).toBe(outDir);
  });

  it("creates valid CKP agent card in claw.yaml", () => {
    const { store, runId, actorId } = setupTestStore();
    const outDir = join(makeTempDir(), "export");

    exportAgent(store, runId, actorId, outDir);

    const clawYaml = YAML.parse(
      readFileSync(join(outDir, "claw.yaml"), "utf-8"),
    );
    expect(clawYaml).toHaveProperty("name");
    expect(clawYaml).toHaveProperty("version");
    expect(clawYaml.apiVersion).toBe("ckp/v1alpha1");
    expect(clawYaml.kind).toBe("AgentCard");
  });

  it("exports correct beliefs", () => {
    const { store, runId, actorId } = setupTestStore();
    const outDir = join(makeTempDir(), "export");

    exportAgent(store, runId, actorId, outDir);

    const beliefs = JSON.parse(
      readFileSync(join(outDir, "beliefs.json"), "utf-8"),
    );
    expect(beliefs).toHaveLength(2);

    const education = beliefs.find(
      (b: { topic: string }) => b.topic === "education",
    );
    const climate = beliefs.find(
      (b: { topic: string }) => b.topic === "climate",
    );
    expect(education).toBeDefined();
    expect(education.sentiment).toBe(0.3);
    expect(climate).toBeDefined();
    expect(climate.sentiment).toBe(-0.5);
  });

  it("scrubs secrets from exported JSON", () => {
    const { store, runId, actorId } = setupTestStore();
    const outDir = join(makeTempDir(), "export");

    exportAgent(store, runId, actorId, outDir);

    // Verify none of the JSON files contain known secret patterns
    const jsonFiles = [
      "actor_state.json",
      "beliefs.json",
      "topics.json",
      "provenance.json",
      "manifest.meta.json",
    ];
    for (const file of jsonFiles) {
      const content = readFileSync(join(outDir, file), "utf-8");
      expect(content).not.toMatch(/sk-[a-zA-Z0-9]/);
      expect(content).not.toMatch(/^Bearer /m);
      expect(content).not.toMatch(/ghp_/);
      expect(content).not.toMatch(/xoxb-/);
    }
  });

  it("throws on missing actor", () => {
    const { store, runId } = setupTestStore();
    const outDir = join(makeTempDir(), "export");

    expect(() => exportAgent(store, runId, "nonexistent", outDir)).toThrow(
      "Actor not found: nonexistent",
    );
  });

  it("scrubs secrets from persona.md and claw.yaml", () => {
    const { store, runId, actorId } = setupTestStore();
    const outDir = join(makeTempDir(), "export");
    exportAgent(store, runId, actorId, outDir);

    const persona = readFileSync(join(outDir, "persona.md"), "utf-8");
    const clawYaml = readFileSync(join(outDir, "claw.yaml"), "utf-8");

    expect(persona).toContain("[REDACTED]");
    expect(persona).not.toContain("sk-secret123");
    expect(clawYaml).not.toContain("sk-secret123");
    expect(clawYaml).not.toContain("Bearer tok_abc");
  });
});

// ═══════════════════════════════════════════════════════
// importAgent
// ═══════════════════════════════════════════════════════

describe("importAgent", () => {
  it("reconstitutes actor with beliefs and topics", () => {
    const { store, runId, actorId } = setupTestStore();
    const outDir = join(makeTempDir(), "export");

    // Export first
    exportAgent(store, runId, actorId, outDir);

    // Import into a fresh run
    const importRunId = "import-run";
    store.createRun({
      id: importRunId,
      started_at: new Date().toISOString(),
      seed: 99,
      config_snapshot: "{}",
      graph_revision_id: "import-test",
      status: "completed",
      total_rounds: 5,
    });

    const result = importAgent(store, importRunId, outDir);

    expect(result.name).toBe("Test Actor");
    expect(result.beliefsImported).toBe(2);
    expect(result.topicsImported).toBe(2);

    // Verify the actor exists in the store
    const importedActor = store.getActor(result.actorId);
    expect(importedActor).not.toBeNull();
    expect(importedActor!.name).toBe("Test Actor");
    expect(importedActor!.run_id).toBe(importRunId);

    // Verify beliefs and topics were imported
    const context = store.queryActorContext(result.actorId, importRunId);
    expect(context.beliefs).toHaveLength(2);
    expect(context.topics).toHaveLength(2);

    const educationBelief = context.beliefs.find((b) => b.topic === "education");
    expect(educationBelief).toBeDefined();
    expect(educationBelief!.sentiment).toBe(0.3);
  });

  it("generates new UUID for imported actor", () => {
    const { store, runId, actorId } = setupTestStore();
    const outDir = join(makeTempDir(), "export");

    exportAgent(store, runId, actorId, outDir);

    const importRunId = "import-run-2";
    store.createRun({
      id: importRunId,
      started_at: new Date().toISOString(),
      seed: 77,
      config_snapshot: "{}",
      graph_revision_id: "import-test-2",
      status: "completed",
      total_rounds: 5,
    });

    const result = importAgent(store, importRunId, outDir);

    expect(result.actorId).not.toBe(actorId);
    // Verify it looks like a UUID
    expect(result.actorId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("throws on missing required files", () => {
    const { store } = setupTestStore();
    const bundleDir = makeTempDir();

    // Create only partial files (missing claw.yaml, beliefs.json, topics.json)
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(
      join(bundleDir, "actor_state.json"),
      JSON.stringify({ stance: "neutral" }),
    );

    expect(() => importAgent(store, "test-run", bundleDir)).toThrow(
      "Missing required file: claw.yaml",
    );
  });
});
