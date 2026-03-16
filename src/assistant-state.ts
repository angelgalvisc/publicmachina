/**
 * assistant-state.ts — Persistent task state for the PublicMachina operator.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantWorkspaceLayout } from "./assistant-workspace.js";

export type AssistantTaskStatus =
  | "idle"
  | "designed"
  | "awaiting_confirmation"
  | "running"
  | "completed"
  | "failed";

export interface DesignedSimulationState {
  title: string;
  brief: string;
  objective: string | null;
  hypothesis: string | null;
  docsPath: string | null;
  specPath: string;
  configPath: string;
  historyRecordId: string | null;
  workspaceDir: string | null;
  rounds: number;
}

export interface RunEstimate {
  rounds: number;
  estimatedMinutes: number;
  estimatedTokens: number | null;
  estimatedCostUsd: number | null;
  searchEnabled: boolean;
}

export interface PendingRunConfirmation {
  specPath: string;
  configPath: string;
  docsPath: string | null;
  dbPath: string;
  runId: string;
  historyRecordId: string | null;
  estimate: RunEstimate;
}

export interface ActiveRunState {
  title: string;
  runId: string;
  dbPath: string;
  historyRecordId: string | null;
  totalRounds: number;
  roundsCompleted: number;
  startedAt: string;
}

export interface CompletedRunState extends ActiveRunState {
  finishedAt: string;
}

export interface FailedRunState {
  title: string | null;
  runId: string | null;
  dbPath: string | null;
  message: string;
  failedAt: string;
}

export interface AssistantTaskState {
  status: AssistantTaskStatus;
  updatedAt: string;
  activeDesign: DesignedSimulationState | null;
  pendingRun: PendingRunConfirmation | null;
  activeRun: ActiveRunState | null;
  lastCompletedRun: CompletedRunState | null;
  lastFailure: FailedRunState | null;
}

const DEFAULT_STATE: AssistantTaskState = {
  status: "idle",
  updatedAt: new Date(0).toISOString(),
  activeDesign: null,
  pendingRun: null,
  activeRun: null,
  lastCompletedRun: null,
  lastFailure: null,
};

export function getAssistantStatePath(layout: AssistantWorkspaceLayout): string {
  return join(layout.stateDir, "state", "current-task.json");
}

export function loadAssistantTaskState(layout: AssistantWorkspaceLayout): AssistantTaskState {
  const filePath = getAssistantStatePath(layout);
  if (!existsSync(filePath)) return structuredClone(DEFAULT_STATE);
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as Partial<AssistantTaskState>;
    return {
      ...structuredClone(DEFAULT_STATE),
      ...parsed,
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    };
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

export function saveAssistantTaskState(
  layout: AssistantWorkspaceLayout,
  state: AssistantTaskState
): void {
  const filePath = getAssistantStatePath(layout);
  mkdirSync(join(layout.stateDir, "state"), { recursive: true });
  writeFileSync(
    filePath,
    `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf-8"
  );
}

export function resetConversationState(layout: AssistantWorkspaceLayout): AssistantTaskState {
  const current = loadAssistantTaskState(layout);
  const next: AssistantTaskState = {
    ...current,
    status: current.activeDesign ? "designed" : "idle",
    pendingRun: null,
    activeRun: null,
    updatedAt: new Date().toISOString(),
  };
  saveAssistantTaskState(layout, next);
  return next;
}

export function setDesignedSimulationState(
  layout: AssistantWorkspaceLayout,
  design: DesignedSimulationState
): AssistantTaskState {
  const current = loadAssistantTaskState(layout);
  const next: AssistantTaskState = {
    ...current,
    status: "designed",
    activeDesign: design,
    pendingRun: null,
    activeRun: null,
    lastFailure: null,
    updatedAt: new Date().toISOString(),
  };
  saveAssistantTaskState(layout, next);
  return next;
}

export function setPendingRunConfirmation(
  layout: AssistantWorkspaceLayout,
  pendingRun: PendingRunConfirmation
): AssistantTaskState {
  const current = loadAssistantTaskState(layout);
  const next: AssistantTaskState = {
    ...current,
    status: "awaiting_confirmation",
    pendingRun,
    lastFailure: null,
    updatedAt: new Date().toISOString(),
  };
  saveAssistantTaskState(layout, next);
  return next;
}

export function setActiveRunState(
  layout: AssistantWorkspaceLayout,
  activeRun: ActiveRunState
): AssistantTaskState {
  const current = loadAssistantTaskState(layout);
  const next: AssistantTaskState = {
    ...current,
    status: "running",
    pendingRun: null,
    activeRun,
    lastFailure: null,
    updatedAt: new Date().toISOString(),
  };
  saveAssistantTaskState(layout, next);
  return next;
}

export function updateActiveRunProgress(
  layout: AssistantWorkspaceLayout,
  roundsCompleted: number
): AssistantTaskState {
  const current = loadAssistantTaskState(layout);
  if (!current.activeRun) return current;
  const next: AssistantTaskState = {
    ...current,
    activeRun: {
      ...current.activeRun,
      roundsCompleted,
    },
    updatedAt: new Date().toISOString(),
  };
  saveAssistantTaskState(layout, next);
  return next;
}

export function setCompletedRunState(
  layout: AssistantWorkspaceLayout,
  completed: CompletedRunState
): AssistantTaskState {
  const current = loadAssistantTaskState(layout);
  const next: AssistantTaskState = {
    ...current,
    status: "completed",
    pendingRun: null,
    activeRun: null,
    lastCompletedRun: completed,
    lastFailure: null,
    updatedAt: new Date().toISOString(),
  };
  saveAssistantTaskState(layout, next);
  return next;
}

export function setFailedRunState(
  layout: AssistantWorkspaceLayout,
  failure: FailedRunState
): AssistantTaskState {
  const current = loadAssistantTaskState(layout);
  const next: AssistantTaskState = {
    ...current,
    status: "failed",
    pendingRun: null,
    activeRun: null,
    lastFailure: failure,
    updatedAt: new Date().toISOString(),
  };
  saveAssistantTaskState(layout, next);
  return next;
}
