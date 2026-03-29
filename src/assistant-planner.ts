/**
 * assistant-planner.ts — LLM-first planning loop for the PublicMachina operator.
 *
 * Architecture: ALL routing decisions are made by the LLM. No regex heuristics,
 * no hardcoded keywords, no language-specific pattern matching. The LLM receives
 * the user input, current state, and available tools, and returns a structured
 * JSON decision. This makes the planner language-agnostic and robust to phrasing
 * variations, colloquialisms, and typos.
 *
 * Reference: PLAN_PRODUCT_EVOLUTION.md, Anthropic harness design patterns (2025)
 */

import type { LLMClient, LLMResponse } from "./llm.js";
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

/**
 * LLM-first planning step. The LLM decides whether to respond directly
 * or call a tool based on the full context. No regex fallbacks.
 */
export async function planAssistantStep(
  llm: LLMClient,
  input: AssistantPlannerInput
): Promise<AssistantPlannerDecision> {
  const prompt = buildPlannerPrompt(input);
  const system = buildPlannerSystemPrompt(input);
  const attempts: AssistantPlannerMeta[] = [];
  const initial = await requestPlannerJson(llm, prompt, system, 800);
  attempts.push(initial.meta);

  let data = initial.data;
  if (!data) {
    const repair = await requestPlannerJson(
      llm,
      buildRepairPrompt(input, initial.raw),
      buildRepairSystemPrompt(),
      400
    );
    attempts.push(repair.meta);
    data = repair.data;
  }

  return finalizePlannerDecision(input, data, mergePlannerMeta(attempts));
}

function buildPlannerPrompt(input: AssistantPlannerInput): string {
  return [
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
  ]
    .filter(Boolean)
    .join("\n");
}

function buildPlannerSystemPrompt(input: AssistantPlannerInput): string {
  const toolList = input.tools.map((t) => t.name).join(", ");

  return [
    "You are PublicMachina, an operator assistant for public narrative simulations.",
    "You understand any language the user writes in. You are language-agnostic.",
    "",
    "## Your decision",
    "Read the user's input, the current task state, and the conversation history.",
    "Decide: respond directly OR call exactly one tool.",
    "",
    "## When to call a tool",
    "",
    "design_simulation:",
    "  - The user provides a simulation brief, scenario description, or structured spec",
    "  - The user asks to design, create, set up, or prepare a simulation",
    "  - The user pastes URLs, documents, or a long structured text (this IS the brief)",
    "  - The user asks to retry or redesign after a failure — find the most recent brief in the conversation and re-use it",
    "  - Pass the user's FULL text as the 'brief' argument. Do NOT summarize or truncate it.",
    "  - If the text mentions a documents path, include it as 'docsPath'",
    "",
    "run_simulation:",
    "  - The user confirms they want to run (yes, confirm, go ahead, do it, dale, hazlo, etc.)",
    "  - ONLY when the current task state shows 'awaiting_confirmation' or 'Pending run'",
    "  - If the user says 'offline' or 'sin búsqueda', set offline: true",
    "",
    "stop_simulation:",
    "  - The user asks to stop, cancel, or abort a running simulation",
    "",
    "query_simulation:",
    "  - The user asks a question about simulation results, data, or metrics",
    "",
    "interview_actor:",
    "  - The user wants to talk to or interview a specific actor from the simulation",
    "",
    "generate_report:",
    "  - The user asks for a report, summary, or analysis of simulation results",
    "",
    "investigate_simulation:",
    "  - The user asks for a deep investigation or ReACT-style analysis of simulation dynamics",
    "",
    "list_history:",
    "  - The user asks about previous simulations, history, or past runs",
    "",
    "export_agent:",
    "  - The user asks to export simulation data (CKP bundle, JSON, etc.)",
    "",
    "switch_provider:",
    "  - The user asks to change the LLM model or provider",
    "",
    "## When to respond directly",
    "  - The user asks a conversational, strategic, or informational question",
    "  - The user asks about PublicMachina itself (capabilities, architecture, etc.)",
    "  - You need more information before you can act",
    "",
    "## Critical rules",
    "  - Do NOT call run_simulation unless the task state shows a pending run awaiting confirmation",
    "  - Do NOT invent file paths, actor names, or run IDs — use what the task state provides",
    "  - When the user provides a long structured text and no explicit command, it IS a design brief → call design_simulation",
    "  - If a previous design failed and the user says 'retry' or 'try again', find the brief from conversation history and call design_simulation with it",
    "",
    `Available tools: ${toolList}`,
    "",
    "## Response format",
    "Return JSON only. No markdown fences, no commentary, no explanation outside the JSON.",
    '{"kind":"respond","message":"your response text"}',
    '{"kind":"tool_call","tool":"tool_name","arguments":{"key":"value"}}',
  ].join("\n");
}

function buildRepairSystemPrompt(): string {
  return [
    "You repair planner outputs for PublicMachina.",
    "Return valid JSON only.",
    '{"kind":"respond","message":"..."} or {"kind":"tool_call","tool":"...","arguments":{...}}',
    "If the source output is truncated, infer the smallest valid JSON that preserves the original intent.",
    "Do not include markdown fences or commentary.",
  ].join("\n");
}

function buildRepairPrompt(input: AssistantPlannerInput, raw: string): string {
  return [
    "The previous planner response was invalid JSON. Repair it.",
    `Latest user input: ${input.userInput.trim()}`,
    `Current task summary: ${input.currentTaskSummary.trim() || "No active task."}`,
    `Known tools: ${input.tools.map((tool) => tool.name).join(", ")}`,
    "Broken planner output:",
    raw.trim() || "(empty response)",
  ].join("\n");
}

async function requestPlannerJson(
  llm: LLMClient,
  prompt: string,
  system: string,
  maxTokens: number
): Promise<{ data: PlannerJson | null; raw: string; meta: AssistantPlannerMeta }> {
  const response = await llm.complete("assistant", prompt, {
    system,
    temperature: 0.0,
    maxTokens,
  });

  return {
    data: parsePlannerJson(response.content),
    raw: response.content,
    meta: toPlannerMeta(response),
  };
}

function finalizePlannerDecision(
  input: AssistantPlannerInput,
  data: PlannerJson | null,
  meta: AssistantPlannerMeta
): AssistantPlannerDecision {
  if (!data) {
    return {
      kind: "respond",
      message: "I need a bit more specificity before I act. Tell me whether you want me to design, run, inspect, report on, or compare a simulation.",
      meta,
    };
  }

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
    const args = normalizePlannerToolArguments(data.tool as AssistantToolName, data.arguments, input);
    return {
      kind: "tool_call",
      tool: data.tool as AssistantToolName,
      arguments: args,
      meta,
    };
  }

  return {
    kind: "respond",
    message: "I need a bit more specificity before I act. Tell me whether you want me to design, run, inspect, report on, or compare a simulation.",
    meta,
  };
}

function normalizePlannerToolArguments(
  tool: AssistantToolName,
  args: Record<string, unknown>,
  input: AssistantPlannerInput
): Record<string, unknown> {
  if (tool === "run_simulation") {
    const offlineSignals = /\boffline\b|\bsin\s+b[uú]squeda\b|\bno\s+search\b/i;
    return offlineSignals.test(input.userInput)
      ? { ...args, offline: true }
      : args;
  }

  if (tool !== "design_simulation") return args;

  // ALWAYS use the full user input as the brief — never let the LLM
  // summarize, rewrite, or truncate the user's brief
  const brief = input.userInput.trim();

  // Only trust docsPath extracted from the actual user input — never from
  // the LLM's response, which may hallucinate paths
  const docsPath = extractDocsPath(brief);

  const normalizedArgs: Record<string, unknown> = {
    ...args,
    brief,
  };
  if (docsPath) {
    normalizedArgs.docsPath = docsPath;
  } else {
    delete normalizedArgs.docsPath;
  }

  return normalizedArgs;
}

function toPlannerMeta(response: LLMResponse): AssistantPlannerMeta {
  return {
    costUsd: response.costUsd,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    model: response.model,
  };
}

function mergePlannerMeta(attempts: AssistantPlannerMeta[]): AssistantPlannerMeta {
  return attempts.reduce<AssistantPlannerMeta>(
    (acc, meta) => ({
      costUsd: acc.costUsd + meta.costUsd,
      inputTokens: acc.inputTokens + meta.inputTokens,
      outputTokens: acc.outputTokens + meta.outputTokens,
      model: meta.model || acc.model,
    }),
    { costUsd: 0, inputTokens: 0, outputTokens: 0, model: "" }
  );
}

function parsePlannerJson(raw: string): PlannerJson | null {
  for (const candidate of plannerJsonCandidates(raw)) {
    try {
      return JSON.parse(candidate) as PlannerJson;
    } catch {
      continue;
    }
  }
  return null;
}

function extractDocsPath(input: string): string | null {
  // Simple extraction — matches common patterns in any language
  const match = input.match(
    /(?:^|\n)\s*(?:documents?\s*path|docs?\s*path|contexto\s*documental|document\s*context|documentos?\s*fuente)\s*:\s*([^\n]+)/i
  );
  if (!match) return null;
  const candidate = match[1]?.trim();
  return candidate ? candidate : null;
}

function plannerJsonCandidates(raw: string): string[] {
  const normalized = normalizePlannerResponse(raw);
  const candidates = [normalized];
  const firstBrace = normalized.indexOf("{");
  const lastBrace = normalized.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(normalized.slice(firstBrace, lastBrace + 1));
  }
  return [...new Set(candidates.map((item) => item.trim()).filter(Boolean))];
}

function normalizePlannerResponse(raw: string): string {
  let text = raw.trim();
  if (text.startsWith("```json")) text = text.slice(7);
  else if (text.startsWith("```")) text = text.slice(3);
  if (text.endsWith("```")) text = text.slice(0, -3);
  return text.trim();
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
