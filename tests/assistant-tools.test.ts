import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, saveConfig, type SimConfig } from "../src/config.js";
import { SQLiteGraphStore } from "../src/db.js";
import {
  bootstrapAssistantWorkspace,
  resolveAssistantWorkspace,
  type AssistantWorkspaceLayout,
} from "../src/assistant-workspace.js";
import {
  loadAssistantTaskState,
  setCompletedRunState,
  setDesignedSimulationState,
  type AssistantTaskState,
} from "../src/assistant-state.js";
import {
  executeAssistantTool,
  getAvailableAssistantTools,
  type AssistantToolRuntime,
} from "../src/assistant-tools.js";
import { acquireActiveRunLock, releaseActiveRunLock } from "../src/run-control.js";

const tempDirs: string[] = [];

interface RuntimeFixture {
  rootDir: string;
  configPath: string;
  docsPath: string;
  workspace: AssistantWorkspaceLayout;
  runtime: AssistantToolRuntime;
  getTaskState: () => AssistantTaskState;
}

function createFixtureConfig(rootDir: string): SimConfig {
  const config = defaultConfig();
  config.assistant.workspaceDir = join(rootDir, "workspace");
  config.output.dir = join(rootDir, "output");
  return config;
}

function createRuntimeFixture(
  mutateConfig?: (config: SimConfig) => void
): RuntimeFixture {
  const rootDir = mkdtempSync(join(tmpdir(), "publicmachina-assistant-tools-"));
  tempDirs.push(rootDir);

  const config = createFixtureConfig(rootDir);
  mutateConfig?.(config);

  const docsPath = join(rootDir, "docs");
  mkdirSync(docsPath, { recursive: true });
  writeFileSync(join(docsPath, "brief.md"), "Context document\n", "utf-8");

  const configPath = join(rootDir, "publicmachina.config.yaml");
  saveConfig(configPath, config);

  const workspace = resolveAssistantWorkspace(config, { configPath });
  bootstrapAssistantWorkspace(workspace, config);

  let currentConfig = config;
  let taskState = loadAssistantTaskState(workspace);

  const runtime: AssistantToolRuntime = {
    get config() {
      return currentConfig;
    },
    configPath,
    workspace,
    get taskState() {
      return taskState;
    },
    mock: true,
    updateConfig: async (nextConfig) => {
      currentConfig = nextConfig;
    },
    updateTaskState: (nextState) => {
      taskState = nextState;
    },
  };

  return {
    rootDir,
    configPath,
    docsPath,
    workspace,
    runtime,
    getTaskState: () => taskState,
  };
}

function seedCompletedRun(dbPath: string, runId = "run-complete"): void {
  const store = new SQLiteGraphStore(dbPath);
  store.createRun({
    id: runId,
    started_at: new Date().toISOString(),
    seed: 42,
    config_snapshot: "{}",
    graph_revision_id: "graph-1",
    status: "completed",
    total_rounds: 8,
  });
  store.addActor({
    id: "actor-1",
    run_id: runId,
    entity_id: null,
    archetype: "persona",
    cognition_tier: "B",
    name: "Elena Ruiz",
    handle: "@elena",
    personality: "A pragmatic local journalist.",
    bio: null,
    age: 34,
    gender: "female",
    profession: "journalist",
    region: "Bogota",
    language: "es",
    stance: "critical",
    sentiment_bias: -0.2,
    activity_level: 0.8,
    influence_weight: 0.6,
    community_id: null,
    active_hours: null,
    follower_count: 500,
    following_count: 200,
  });
  store.addActorBelief("actor-1", "education", -0.4, 0);
  store.addActorTopic("actor-1", "education", 0.9);
  store.close();
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("assistant-tools hardening", () => {
  it("blocks runs that would exceed the operator session budget", async () => {
    const fixture = createRuntimeFixture((config) => {
      config.assistant.limits.sessionCostBudgetUsd = 0.000001;
    });
    const specPath = join(fixture.rootDir, "simulation.spec.json");
    writeFileSync(specPath, "{}\n", "utf-8");

    fixture.runtime.updateTaskState(
      setDesignedSimulationState(fixture.workspace, {
        title: "Budget test",
        brief: "Run an expensive scenario.",
        objective: "Stress token spending",
        hypothesis: null,
        docsPath: fixture.docsPath,
        actorCount: null,
        specPath,
        configPath: fixture.configPath,
        historyRecordId: null,
        workspaceDir: fixture.workspace.rootDir,
        rounds: 72,
      })
    );

    const result = await executeAssistantTool("run_simulation", { offline: true }, fixture.runtime);
    expect(result.status).toBe("error");
    expect(result.summary).toContain("exceed the current operator session budget");
    expect(result.details).toContain("session cap");
    expect(fixture.getTaskState().status).toBe("designed");
  });

  it("rejects CKP export paths that escape the workspace", async () => {
    const fixture = createRuntimeFixture();
    const dbPath = join(fixture.rootDir, "simulation.db");
    seedCompletedRun(dbPath);

    fixture.runtime.updateTaskState(
      setCompletedRunState(fixture.workspace, {
        title: "Export test",
        runId: "run-complete",
        dbPath,
        historyRecordId: null,
        totalRounds: 8,
        roundsCompleted: 8,
        startedAt: "2026-03-16T00:00:00.000Z",
        finishedAt: "2026-03-16T00:10:00.000Z",
      })
    );

    const result = await executeAssistantTool(
      "export_agent",
      {
        actorName: "Elena Ruiz",
        outDir: join(tmpdir(), "outside-export"),
      },
      fixture.runtime
    );

    expect(result.status).toBe("error");
    expect(result.summary).toBe("Tool export_agent failed.");
    expect(result.details).toContain("workspace");
  });

  it("rejects a new run when another process already holds the workspace lock", async () => {
    const fixture = createRuntimeFixture();
    const specPath = join(fixture.rootDir, "simulation.spec.json");
    writeFileSync(specPath, "{}\n", "utf-8");

    fixture.runtime.updateTaskState(
      setDesignedSimulationState(fixture.workspace, {
        title: "Concurrency test",
        brief: "Run while another run is active.",
        objective: "Ensure only one active run per workspace",
        hypothesis: null,
        docsPath: fixture.docsPath,
        actorCount: null,
        specPath,
        configPath: fixture.configPath,
        historyRecordId: null,
        workspaceDir: fixture.workspace.rootDir,
        rounds: 72,
      })
    );

    acquireActiveRunLock(fixture.workspace, {
      runId: "other-run",
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      source: "assistant",
    });

    const result = await executeAssistantTool(
      "run_simulation",
      { confirmed: true, offline: true },
      fixture.runtime
    );

    expect(result.status).toBe("error");
    expect(result.summary).toBe("Tool run_simulation failed.");
    expect(result.details).toContain("already running");

    releaseActiveRunLock(fixture.workspace, "other-run");
  });

  it("completes design from a brief with URLs even when mock LLM returns generic spec", async () => {
    const fixture = createRuntimeFixture();
    const fetchMock = vi.fn(async () =>
      new Response(
        "<html><head><title>NemoClaw Article</title></head><body><article>NVIDIA NemoClaw may affect Bitcoin sentiment through AI spillover.</article></body></html>",
        {
          status: 200,
          headers: { "content-type": "text/html" },
        }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await executeAssistantTool(
        "design_simulation",
        {
          brief: [
            "Design a new simulation from scratch.",
            "",
            "Title:",
            "Narrative impact of NemoClaw on Bitcoin",
            "",
            "Objective:",
            "Measure whether the effect is material or mostly narrative noise.",
            "",
            "Primary source:",
            "https://es.wired.com/articulos/nvidia-lanzara-una-plataforma-de-agentes-de-ia-de-codigo-abierto",
            "",
            "Configuration:",
            "- 10 actors",
            "- 16 rounds",
            "- web search enabled",
          ].join("\n"),
        },
        fixture.runtime
      );

      // With LLM-first design, the mock returns a generic spec.
      // The design should still complete successfully.
      expect(result.status).toBe("completed");
      expect(result.details).toContain("Simulation Plan");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("exposes only the tools that are valid for the current task state", () => {
    const fixture = createRuntimeFixture();

    const idleTools = getAvailableAssistantTools(fixture.getTaskState()).map((tool) => tool.name);
    expect(idleTools).toEqual(["design_simulation", "list_history", "switch_provider"]);

    fixture.runtime.updateTaskState(
      setDesignedSimulationState(fixture.workspace, {
        title: "Tool state test",
        brief: "Design a simulation.",
        objective: "Verify tool exposure",
        hypothesis: null,
        docsPath: fixture.docsPath,
        actorCount: 10,
        specPath: join(fixture.rootDir, "simulation.spec.json"),
        configPath: fixture.configPath,
        historyRecordId: null,
        workspaceDir: fixture.workspace.rootDir,
        rounds: 16,
      })
    );

    const designedTools = getAvailableAssistantTools(fixture.getTaskState()).map((tool) => tool.name);
    expect(designedTools).toContain("run_simulation");
    expect(designedTools).not.toContain("stop_simulation");
    expect(designedTools).not.toContain("generate_report");
  });

  it("rejects operator runs that are not grounded unless offline is explicit", async () => {
    const fixture = createRuntimeFixture();
    const specPath = join(fixture.rootDir, "simulation.spec.json");
    writeFileSync(specPath, "{}\n", "utf-8");

    fixture.runtime.updateTaskState(
      setDesignedSimulationState(fixture.workspace, {
        title: "Grounding test",
        brief: "Run with default search settings.",
        objective: "Ensure the operator enforces grounding by default",
        hypothesis: null,
        docsPath: fixture.docsPath,
        actorCount: 10,
        specPath,
        configPath: fixture.configPath,
        historyRecordId: null,
        workspaceDir: fixture.workspace.rootDir,
        rounds: 16,
      })
    );

    const result = await executeAssistantTool("run_simulation", {}, fixture.runtime);
    expect(result.status).toBe("error");
    expect(result.summary).toBe("Tool run_simulation failed.");
    expect(result.details).toContain("Grounded runs require search.enabled=true");
  });
});
