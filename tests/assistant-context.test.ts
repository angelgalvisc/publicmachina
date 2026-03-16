import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { buildAssistantContext } from "../src/assistant-context.js";
import { defaultConfig } from "../src/config.js";
import {
  addDurableMemory,
  bootstrapAssistantWorkspace,
  recordSimulationHistory,
  resolveAssistantWorkspace,
  updateUserProfile,
} from "../src/assistant-workspace.js";
import { appendAssistantMessage, createAssistantSession } from "../src/assistant-session.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("assistant-context.ts", () => {
  it("builds operator context from identity, profile, memory, sessions, and prior simulations", () => {
    const dir = mkdtempSync(join(tmpdir(), "publicmachina-assistant-context-"));
    tempDirs.push(dir);

    const config = defaultConfig();
    config.assistant.workspaceDir = join(dir, "workspace");
    const layout = resolveAssistantWorkspace(config);
    bootstrapAssistantWorkspace(layout, config);

    updateUserProfile(layout, {
      preferredName: "Angel",
      lastContext: "Latin American public policy",
      addNote: "Cares about institutional responses",
    });
    addDurableMemory(layout, {
      kind: "simulation",
      summary: "Previous runs should compare media narratives against institutional reaction speed",
      tags: ["comparison"],
    });
    recordSimulationHistory(layout, {
      title: "Health ministry recall crisis",
      objective: "Track how journalists and regulators respond to a product recall",
      hypothesis: "Regulators move slower than media framing",
      brief: "Simulate recall response over 10 rounds.",
      tags: ["recall", "regulation"],
    });

    const session = createAssistantSession(layout);
    appendAssistantMessage(session, "user", "Please remember that we focus on Colombia.");
    appendAssistantMessage(session, "assistant", "Understood. I will keep Colombia as the default context.");

    const bundle = buildAssistantContext(layout, config, "product recall in Colombia");
    expect(bundle.summary).toContain("Preferred name: Angel");
    expect(bundle.summary).toContain("Cares about institutional responses");
    expect(bundle.summary).toContain("Health ministry recall crisis");
    expect(bundle.summary).toContain("focus on Colombia");
    expect(bundle.relevantSimulations).toHaveLength(1);
  });
});
