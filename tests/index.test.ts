/**
 * index.test.ts — Tests for the actual Commander CLI wiring
 *
 * Covers:
 * - simulate command with MockCognitionBackend via --mock
 * - stats command output formatting and tier breakdown
 * - error path when no runs exist
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { SQLiteGraphStore } from "../src/db.js";
import type { ActorRow } from "../src/db.js";
import { runCli } from "../src/index.js";
import { updateRound } from "../src/telemetry.js";

const tempDirs: string[] = [];

function makeTempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "seldonclaw-cli-"));
  tempDirs.push(dir);
  return join(dir, "simulation.db");
}

function makeActor(overrides: Partial<ActorRow> = {}): ActorRow {
  return {
    id: "actor-1",
    run_id: "run-1",
    entity_id: null,
    archetype: "persona",
    cognition_tier: "B",
    name: "Test Actor",
    handle: "@test",
    personality: "A test persona",
    bio: null,
    age: 25,
    gender: "male",
    profession: null,
    region: null,
    language: "es",
    stance: "neutral",
    sentiment_bias: 0.0,
    activity_level: 1.0,
    influence_weight: 0.5,
    community_id: null,
    active_hours: null,
    follower_count: 50,
    following_count: 30,
    ...overrides,
  };
}

function makeIO() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: (text: string) => {
        stdout += text;
      },
      stderr: (text: string) => {
        stderr += text;
      },
    },
    getStdout: () => stdout,
    getStderr: () => stderr,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("CLI simulate", () => {
  it("runs simulation through commander with --mock", async () => {
    const dbPath = makeTempDbPath();
    const store = new SQLiteGraphStore(dbPath);
    store.createRun({
      id: "run-1",
      started_at: "2024-01-01T00:00:00",
      seed: 42,
      config_snapshot: "{}",
      graph_revision_id: "rev-1",
      status: "running",
      total_rounds: 1,
    });
    store.addActor(makeActor({ id: "actor-a", run_id: "run-1", handle: "@a" }));
    store.addActorTopic("actor-a", "education", 1.0);
    store.addActorBelief("actor-a", "education", 0.2, 0);
    store.close();

    const capture = makeIO();
    await runCli(
      [
        "node",
        "seldonclaw",
        "simulate",
        "--db",
        dbPath,
        "--run",
        "run-1",
        "--rounds",
        "1",
        "--mock",
      ],
      capture.io
    );

    expect(capture.getStdout()).toContain("Simulation completed");
    expect(capture.getStdout()).toContain("Run ID: run-1");

    const verifyStore = new SQLiteGraphStore(dbPath);
    const run = verifyStore.getRun("run-1");
    const summary = verifyStore.getRunRoundSummary("run-1");
    verifyStore.close();

    expect(run?.status).toBe("completed");
    expect(summary.roundsCompleted).toBe(1);
  });
});

describe("CLI stats", () => {
  it("prints run summary and tier breakdown", async () => {
    const dbPath = makeTempDbPath();
    const store = new SQLiteGraphStore(dbPath);
    store.createRun({
      id: "run-1",
      started_at: "2024-01-01T00:00:00",
      seed: 42,
      config_snapshot: "{}",
      graph_revision_id: "rev-1",
      status: "completed",
      total_rounds: 2,
      finished_at: "2024-01-01T02:00:00",
    });
    store.addActor(makeActor({ id: "a1", cognition_tier: "A" }));
    store.addActor(makeActor({ id: "a2", cognition_tier: "B" }));
    store.addActor(makeActor({ id: "a3", cognition_tier: "C" }));
    updateRound(store, {
      num: 0,
      runId: "run-1",
      totalPosts: 5,
      totalActions: 8,
      activeActors: 3,
      tierACalls: 1,
      tierBCalls: 2,
      tierCActions: 5,
    });
    updateRound(store, {
      num: 1,
      runId: "run-1",
      totalPosts: 7,
      totalActions: 11,
      activeActors: 2,
      tierACalls: 2,
      tierBCalls: 3,
      tierCActions: 6,
    });
    store.close();

    const capture = makeIO();
    await runCli(
      ["node", "seldonclaw", "stats", "--db", dbPath, "--run", "run-1", "--tiers"],
      capture.io
    );

    const output = capture.getStdout();
    expect(output).toContain("Run: run-1");
    expect(output).toContain("Status: completed");
    expect(output).toContain("Rounds completed: 2");
    expect(output).toContain("Total posts: 12");
    expect(output).toContain("Total actions: 19");
    expect(output).toContain("A (always LLM): 1 actors");
    expect(output).toContain("Tier A calls: 3");
    expect(output).toContain("Tier B calls: 5");
    expect(output).toContain("Tier C actions: 11");
  });

  it("fails clearly when no runs exist", async () => {
    const dbPath = makeTempDbPath();
    const store = new SQLiteGraphStore(dbPath);
    store.close();

    const capture = makeIO();
    await expect(
      runCli(["node", "seldonclaw", "stats", "--db", dbPath], capture.io)
    ).rejects.toThrow("No runs found in database.");
  });
});
