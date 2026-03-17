import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { bootstrapAssistantWorkspace, resolveAssistantWorkspace } from "../src/assistant-workspace.js";
import {
  addSessionUsage,
  setActiveRunState,
  setCancelledRunState,
  setCancellingRunState,
  loadAssistantTaskState,
  resetConversationState,
  setDesignedSimulationState,
  setPendingRunConfirmation,
} from "../src/assistant-state.js";

const tempDirs: string[] = [];

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "publicmachina-assistant-state-"));
  tempDirs.push(dir);
  const config = defaultConfig();
  config.assistant.workspaceDir = dir;
  const layout = resolveAssistantWorkspace(config, { cwd: dir });
  bootstrapAssistantWorkspace(layout, config);
  return layout;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("assistant-state.ts", () => {
  it("persists designed simulations and pending confirmations", () => {
    const layout = makeWorkspace();

    setDesignedSimulationState(layout, {
      title: "Bogota rumor crisis",
      brief: "Simulate rumor escalation in Bogota.",
      objective: "Track rumor escalation",
      hypothesis: "Local media accelerates panic",
      docsPath: "./docs/rumor",
      actorCount: 6,
      specPath: "/tmp/spec.json",
      configPath: "/tmp/config.yaml",
      historyRecordId: "hist-1",
      workspaceDir: layout.rootDir,
      rounds: 12,
    });

    let state = loadAssistantTaskState(layout);
    expect(state.status).toBe("designed");
    expect(state.activeDesign?.title).toBe("Bogota rumor crisis");
    expect(state.activeDesign?.actorCount).toBe(6);

    setPendingRunConfirmation(layout, {
      specPath: "/tmp/spec.json",
      configPath: "/tmp/config.yaml",
      docsPath: "./docs/rumor",
      dbPath: "/tmp/simulation.db",
      runId: "run-123",
      historyRecordId: "hist-1",
      estimate: {
        rounds: 12,
        estimatedMinutes: 4,
        estimatedTokens: 12000,
        estimatedCostUsd: 0.12,
        searchEnabled: false,
      },
    });

    state = loadAssistantTaskState(layout);
    expect(state.status).toBe("awaiting_confirmation");
    expect(state.pendingRun?.runId).toBe("run-123");
  });

  it("clears pending confirmation without deleting the active design", () => {
    const layout = makeWorkspace();

    setDesignedSimulationState(layout, {
      title: "Election rumors",
      brief: "Simulate election rumors.",
      objective: "Map rumor spread",
      hypothesis: null,
      docsPath: "./docs/elections",
      actorCount: null,
      specPath: "/tmp/spec.json",
      configPath: "/tmp/config.yaml",
      historyRecordId: "hist-2",
      workspaceDir: layout.rootDir,
      rounds: 8,
    });
    setPendingRunConfirmation(layout, {
      specPath: "/tmp/spec.json",
      configPath: "/tmp/config.yaml",
      docsPath: "./docs/elections",
      dbPath: "/tmp/simulation.db",
      runId: "run-456",
      historyRecordId: "hist-2",
      estimate: {
        rounds: 8,
        estimatedMinutes: 3,
        estimatedTokens: 8000,
        estimatedCostUsd: 0.08,
        searchEnabled: true,
      },
    });

    const state = resetConversationState(layout);
    expect(state.status).toBe("designed");
    expect(state.activeDesign?.title).toBe("Election rumors");
    expect(state.pendingRun).toBeNull();
  });

  it("tracks cancelling and cancelled runs separately from failures", () => {
    const layout = makeWorkspace();

    setActiveRunState(layout, {
      title: "Rumor escalation",
      runId: "run-stop",
      dbPath: "/tmp/simulation.db",
      historyRecordId: "hist-3",
      totalRounds: 12,
      roundsCompleted: 3,
      startedAt: "2026-03-16T00:00:00.000Z",
    });
    let state = setCancellingRunState(layout);
    expect(state.status).toBe("cancelling");
    expect(state.activeRun?.runId).toBe("run-stop");

    state = setCancelledRunState(layout, {
      title: "Rumor escalation",
      runId: "run-stop",
      dbPath: "/tmp/simulation.db",
      historyRecordId: "hist-3",
      totalRounds: 12,
      roundsCompleted: 4,
      startedAt: "2026-03-16T00:00:00.000Z",
      finishedAt: "2026-03-16T00:05:00.000Z",
      reason: "Requested by operator",
    });
    expect(state.status).toBe("cancelled");
    expect(state.activeRun).toBeNull();
    expect(state.lastCancelledRun?.roundsCompleted).toBe(4);
    expect(state.lastFailure).toBeNull();
  });

  it("resets session usage on /clear semantics", () => {
    const layout = makeWorkspace();
    let state = addSessionUsage(layout, { costUsd: 1.25, toolCalls: 3 });
    expect(state.sessionUsage.costUsd).toBeCloseTo(1.25);
    expect(state.sessionUsage.toolCalls).toBe(3);

    state = resetConversationState(layout);
    expect(state.sessionUsage.costUsd).toBe(0);
    expect(state.sessionUsage.toolCalls).toBe(0);
  });

  it("preserves an active run across /clear semantics", () => {
    const layout = makeWorkspace();

    setActiveRunState(layout, {
      title: "BTC and AI",
      runId: "run-live",
      dbPath: "/tmp/live.db",
      historyRecordId: "hist-live",
      totalRounds: 16,
      roundsCompleted: 5,
      startedAt: "2026-03-17T00:00:00.000Z",
    });

    const state = resetConversationState(layout);
    expect(state.status).toBe("running");
    expect(state.activeRun?.runId).toBe("run-live");
    expect(state.pendingRun).toBeNull();
  });
});
