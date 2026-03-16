import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import {
  addDurableMemory,
  appendDailyNote,
  bootstrapAssistantWorkspace,
  listSimulationHistory,
  loadSimulationHistory,
  loadUserProfile,
  recordSimulationHistory,
  resolveAssistantWorkspace,
  updateUserProfile,
} from "../src/assistant-workspace.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("assistant-workspace.ts", () => {
  it("bootstraps a CKP-inspired operator workspace with visible identity files", () => {
    const dir = mkdtempSync(join(tmpdir(), "publicmachina-assistant-"));
    tempDirs.push(dir);

    const config = defaultConfig();
    config.assistant.workspaceDir = join(dir, "workspace");

    const layout = resolveAssistantWorkspace(config);
    bootstrapAssistantWorkspace(layout, config);

    expect(readFileSync(layout.files.agents, "utf-8")).toContain("PublicMachina Workspace");
    expect(readFileSync(layout.files.identity, "utf-8")).toContain("auditable simulation operator");
    expect(readFileSync(layout.files.soul, "utf-8")).toContain("Be calm, direct");
    expect(readFileSync(layout.files.user, "utf-8")).toContain("PUBLICMACHINA:USER-PROFILE");
    expect(readFileSync(layout.files.memory, "utf-8")).toContain("PUBLICMACHINA:DURABLE-MEMORY");
  });

  it("persists user profile, durable memory, daily notes, and simulation history", () => {
    const dir = mkdtempSync(join(tmpdir(), "publicmachina-assistant-history-"));
    tempDirs.push(dir);

    const config = defaultConfig();
    config.assistant.workspaceDir = join(dir, "workspace");
    const layout = resolveAssistantWorkspace(config);
    bootstrapAssistantWorkspace(layout, config);

    updateUserProfile(layout, {
      preferredName: "Angel",
      lastContext: "Public policy in Colombia",
      addNote: "Prefers concise analytical language",
    });
    const profile = loadUserProfile(layout);
    expect(profile.preferredName).toBe("Angel");

    addDurableMemory(layout, {
      kind: "preference",
      summary: "Prefers concise analytical language",
      tags: ["style"],
    });
    expect(readFileSync(layout.files.memory, "utf-8")).toContain("Prefers concise analytical language");

    appendDailyNote(layout, {
      title: "First operator session",
      lines: ["Collected user preferences", "Prepared a crisis simulation brief"],
      timestamp: new Date("2026-03-16T03:00:00Z"),
    });
    expect(readFileSync(join(layout.memoryDir, "2026-03-16.md"), "utf-8")).toContain("First operator session");

    const specPath = join(dir, "simulation.spec.json");
    const configPath = join(dir, "publicmachina.generated.config.yaml");
    writeFileSync(specPath, "{}\n", "utf-8");
    writeFileSync(configPath, "simulation: {}\n", "utf-8");

    recordSimulationHistory(layout, {
      title: "Bogota education unrest",
      objective: "Forecast public reaction to tuition hikes",
      hypothesis: "Media and institutions polarize sentiment quickly",
      brief: "Simulate journalists, university leadership, and students over 12 rounds.",
      context: "National media spillover and local political pressure",
      specPath,
      configPath,
      docsPath: "./docs/tuition",
      runId: "run-1",
      dbPath: "./simulation.db",
      tags: ["education", "bogota"],
    });

    const history = loadSimulationHistory(layout);
    expect(history).toHaveLength(1);
    expect(history[0].title).toBe("Bogota education unrest");
    expect(listSimulationHistory(layout, { query: "tuition bogota" })).toHaveLength(1);
  });
});
