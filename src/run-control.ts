/**
 * run-control.ts — Cooperative stop requests for long-running simulations.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantWorkspaceLayout } from "./assistant-workspace.js";

export interface StopRequest {
  requestedAt: string;
  source: "signal" | "command" | "assistant";
  runId?: string | null;
  reason?: string | null;
}

export interface ActiveRunLock {
  runId: string;
  pid: number;
  acquiredAt: string;
  source: "assistant" | "run" | "simulate";
}

export interface GracefulStopIO {
  stderr(text: string): void;
}

export interface GracefulStopController {
  signal: AbortSignal;
  requestStop: (request: StopRequest) => void;
  cleanup: () => void;
}

export class SimulationCancelledError extends Error {
  constructor(message = "Simulation cancelled") {
    super(message);
    this.name = "SimulationCancelledError";
  }
}

function getStopRequestPath(layout: AssistantWorkspaceLayout): string {
  return join(layout.stateDir, "state", "stop-request.json");
}

function getActiveRunLockPath(layout: AssistantWorkspaceLayout): string {
  return join(layout.stateDir, "state", "active-run.json");
}

export function readStopRequest(layout: AssistantWorkspaceLayout): StopRequest | null {
  const filePath = getStopRequestPath(layout);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as StopRequest;
  } catch {
    return null;
  }
}

export function writeStopRequest(
  layout: AssistantWorkspaceLayout,
  request: StopRequest
): StopRequest {
  const filePath = getStopRequestPath(layout);
  mkdirSync(join(layout.stateDir, "state"), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(request, null, 2)}\n`, "utf-8");
  return request;
}

export function clearStopRequest(layout: AssistantWorkspaceLayout): void {
  rmSync(getStopRequestPath(layout), { force: true });
}

export function readActiveRunLock(layout: AssistantWorkspaceLayout): ActiveRunLock | null {
  const filePath = getActiveRunLockPath(layout);
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as ActiveRunLock;
    if (!parsed.runId || !parsed.pid) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function acquireActiveRunLock(
  layout: AssistantWorkspaceLayout,
  nextLock: ActiveRunLock
): ActiveRunLock {
  const filePath = getActiveRunLockPath(layout);
  mkdirSync(join(layout.stateDir, "state"), { recursive: true });
  const existing = readActiveRunLock(layout);
  if (existing && existing.runId !== nextLock.runId && isPidAlive(existing.pid)) {
    throw new Error(`Another simulation is already running in this workspace (${existing.runId}).`);
  }
  writeFileSync(filePath, `${JSON.stringify(nextLock, null, 2)}\n`, "utf-8");
  return nextLock;
}

export function releaseActiveRunLock(
  layout: AssistantWorkspaceLayout,
  runId?: string | null
): void {
  const existing = readActiveRunLock(layout);
  if (runId && existing?.runId && existing.runId !== runId) return;
  rmSync(getActiveRunLockPath(layout), { force: true });
}

export function stopRequestAppliesToRun(
  request: StopRequest | null,
  runId?: string | null
): boolean {
  if (!request) return false;
  if (!request.runId) return true;
  return request.runId === runId;
}

export function createGracefulStopController(
  io: GracefulStopIO,
  onFirstInterrupt: () => void
): GracefulStopController {
  const controller = new AbortController();
  let stopping = false;

  const requestStop = (request: StopRequest): void => {
    if (stopping) return;
    stopping = true;
    onFirstInterrupt();
    controller.abort(request);
  };

  const onSigint = (): void => {
    if (!stopping) {
      io.stderr("Stop requested. Finishing the current safe checkpoint. Press Ctrl+C again to force exit.\n");
      requestStop({
        requestedAt: new Date().toISOString(),
        source: "signal",
        reason: "SIGINT",
      });
      return;
    }
    io.stderr("Force exiting.\n");
    process.exit(130);
  };

  process.on("SIGINT", onSigint);

  return {
    signal: controller.signal,
    requestStop,
    cleanup: () => {
      process.off("SIGINT", onSigint);
    },
  };
}

export function throwIfStopRequested(options: {
  signal?: AbortSignal;
  shouldStop?: () => boolean;
  message?: string;
}): void {
  if (options.signal?.aborted || options.shouldStop?.()) {
    throw new SimulationCancelledError(options.message);
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
