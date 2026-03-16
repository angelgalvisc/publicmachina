import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { bootstrapAssistantWorkspace, resolveAssistantWorkspace } from "../src/assistant-workspace.js";
import {
  acquireActiveRunLock,
  readActiveRunLock,
  releaseActiveRunLock,
  writeStopRequest,
  readStopRequest,
  clearStopRequest,
  stopRequestAppliesToRun,
} from "../src/run-control.js";

const tempDirs: string[] = [];

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "publicmachina-run-control-"));
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

describe("run-control.ts", () => {
  it("acquires and releases the active run lock", () => {
    const layout = makeWorkspace();
    acquireActiveRunLock(layout, {
      runId: "run-1",
      pid: process.pid,
      acquiredAt: "2026-03-16T00:00:00.000Z",
      source: "run",
    });

    expect(readActiveRunLock(layout)?.runId).toBe("run-1");

    releaseActiveRunLock(layout, "run-1");
    expect(readActiveRunLock(layout)).toBeNull();
  });

  it("rejects a second active run lock when the existing pid is alive", () => {
    const layout = makeWorkspace();
    acquireActiveRunLock(layout, {
      runId: "run-1",
      pid: process.pid,
      acquiredAt: "2026-03-16T00:00:00.000Z",
      source: "assistant",
    });

    expect(() =>
      acquireActiveRunLock(layout, {
        runId: "run-2",
        pid: process.pid,
        acquiredAt: "2026-03-16T00:05:00.000Z",
        source: "simulate",
      })
    ).toThrow(/already running/);
  });

  it("stores stop requests and matches them against the requested run", () => {
    const layout = makeWorkspace();
    writeStopRequest(layout, {
      requestedAt: "2026-03-16T00:00:00.000Z",
      source: "assistant",
      runId: "run-9",
      reason: "Operator requested a stop.",
    });

    const stopRequest = readStopRequest(layout);
    expect(stopRequest?.runId).toBe("run-9");
    expect(stopRequestAppliesToRun(stopRequest, "run-9")).toBe(true);
    expect(stopRequestAppliesToRun(stopRequest, "run-10")).toBe(false);

    clearStopRequest(layout);
    expect(readStopRequest(layout)).toBeNull();
  });
});
