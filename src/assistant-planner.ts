/**
 * assistant-planner.ts — LLM planning loop for the PublicMachina operator.
 */

import type { LLMClient } from "./llm.js";
import type { AssistantToolDefinition, AssistantToolName } from "./assistant-tools.js";

export type AssistantPlannerDecision =
  | {
      kind: "respond";
      message: string;
      meta: AssistantPlannerMeta;
    }
  | {
      kind: "tool_call";
      tool: AssistantToolName;
      arguments: Record<string, unknown>;
      meta: AssistantPlannerMeta;
    };

export interface AssistantPlannerInput {
  contextSummary: string;
  currentTaskSummary: string;
  conversation: Array<{ role: "user" | "assistant"; content: string }>;
  userInput: string;
  tools: AssistantToolDefinition[];
  toolTrace?: string[];
}

interface PlannerJson {
  kind?: unknown;
  message?: unknown;
  tool?: unknown;
  arguments?: unknown;
}

export interface AssistantPlannerMeta {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export async function planAssistantStep(
  llm: LLMClient,
  input: AssistantPlannerInput
): Promise<AssistantPlannerDecision> {
  const prompt = [
    "Operator workspace context:",
    input.contextSummary.trim() || "No workspace context available.",
    "",
    "Current task state:",
    input.currentTaskSummary.trim() || "No active task.",
    "",
    "Recent conversation:",
    formatConversation(input.conversation),
    "",
    input.toolTrace && input.toolTrace.length > 0
      ? `Tool trace so far:\n${input.toolTrace.join("\n")}\n`
      : "",
    `Latest user input:\n${input.userInput.trim()}`,
    "",
    "Available tools:",
    renderTools(input.tools),
  ]
    .filter(Boolean)
    .join("\n");

  const system = [
    "You are PublicMachina, an operator assistant for public narrative simulations.",
    "You can either answer directly or choose exactly one tool call per step.",
    "Use tools when the user is asking you to design, run, inspect, report, export, query, interview, review history, or switch providers/models.",
    "Do not call run_simulation unless the user is asking to run a simulation or confirming a run.",
    "Do not invent file paths, actor names, or run IDs when the current task state already has them.",
    "If the user is making a conversational or strategic request, answer directly.",
    "Return JSON only.",
    'JSON schema: {"kind":"respond","message":"..."} or {"kind":"tool_call","tool":"...","arguments":{...}}',
  ].join("\n");

  const response = await llm.completeJSON<PlannerJson>("simulation", prompt, {
    system,
    temperature: 0.0,
    maxTokens: 800,
  });
  const { data } = response;
  const meta: AssistantPlannerMeta = {
    costUsd: response.meta.costUsd,
    inputTokens: response.meta.inputTokens,
    outputTokens: response.meta.outputTokens,
    model: response.meta.model,
  };

  if (data.kind === "respond" && typeof data.message === "string" && data.message.trim()) {
    return {
      kind: "respond",
      message: data.message.trim(),
      meta,
    };
  }

  if (
    data.kind === "tool_call" &&
    typeof data.tool === "string" &&
    input.tools.some((tool) => tool.name === data.tool) &&
    isObject(data.arguments)
  ) {
    return {
      kind: "tool_call",
      tool: data.tool as AssistantToolName,
      arguments: data.arguments,
      meta,
    };
  }

  return {
    kind: "respond",
    message: "I need a bit more specificity before I act. Tell me whether you want me to design, run, inspect, report on, or compare a simulation.",
    meta,
  };
}

function renderTools(tools: AssistantToolDefinition[]): string {
  return tools
    .map((tool) => {
      const params = Object.entries(tool.parameters)
        .map(([name, description]) => `  - ${name}: ${description}`)
        .join("\n");
      return `${tool.name}: ${tool.description}\n${params}`;
    })
    .join("\n\n");
}

function formatConversation(
  conversation: Array<{ role: "user" | "assistant"; content: string }>
): string {
  if (conversation.length === 0) {
    return "- No conversation yet in this session.";
  }
  return conversation
    .slice(-10)
    .map((message) => `- ${message.role}: ${message.content}`)
    .join("\n");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
