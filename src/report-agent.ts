/**
 * report-agent.ts — ReACT-style orchestrator for investigative analysis
 *
 * Combines existing building blocks (report, interview, query-service)
 * into an autonomous analysis loop that:
 *   1. Receives a question/objective
 *   2. Forms a hypothesis
 *   3. Queries the simulation database
 *   4. Interviews key actors
 *   5. Checks counter-evidence
 *   6. Synthesizes a structured report
 *
 * Reference: PLAN_PRODUCT_EVOLUTION.md §8, IMPLEMENTATION_CHECKLIST.md Phase 8
 */

import type { GraphStore } from "./db.js";
import type { LLMClient } from "./llm.js";
import type { CognitionBackend } from "./cognition.js";
import { computeMetrics, type ReportMetrics } from "./report.js";
import { resolveActorByName, formatActorContext, interviewActor } from "./interview.js";
import { extractSchema, nlToSql, executeQuery, formatTable } from "./query-service.js";

// ═══════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════

export interface ReportAgentInput {
  runId: string;
  objective: string;
  /** Max ReACT iterations (default: 5) */
  maxSteps?: number;
}

export interface ReportAgentStep {
  type: "thought" | "tool" | "observation" | "synthesis";
  content: string;
  toolName?: string;
  toolInput?: string;
}

export interface ReportAgentOutput {
  objective: string;
  steps: ReportAgentStep[];
  synthesis: string;
  keyFindings: string[];
  actorsInterviewed: string[];
  queriesExecuted: number;
}

// ═══════════════════════════════════════════════════════
// TOOLS AVAILABLE TO THE AGENT
// ═══════════════════════════════════════════════════════

interface AgentTool {
  name: string;
  description: string;
  execute: (input: string) => Promise<string>;
}

function buildAgentTools(
  store: GraphStore,
  llm: LLMClient,
  backend: CognitionBackend,
  runId: string,
  metrics: ReportMetrics,
  schema: ReturnType<typeof extractSchema>
): AgentTool[] {
  return [
    {
      name: "query_simulation",
      description: "Execute a natural-language question against the simulation database. Returns tabular results.",
      execute: async (question: string) => {
        try {
          const sql = await nlToSql(llm, schema, question);
          const result = executeQuery(store, sql);
          return `SQL: ${sql}\n\n${formatTable(result.columns, result.rows.slice(0, 20))}`;
        } catch (err) {
          return `Query failed: ${(err as Error).message}`;
        }
      },
    },
    {
      name: "interview_actor",
      description: "Ask a simulated actor a question about their behavior or motivations.",
      execute: async (input: string) => {
        // Parse "ActorName: question" format
        const colonIndex = input.indexOf(":");
        if (colonIndex === -1) return "Format: ActorName: your question";
        const actorName = input.slice(0, colonIndex).trim();
        const question = input.slice(colonIndex + 1).trim();

        try {
          const actor = resolveActorByName(store, runId, actorName);
          const result = await interviewActor(store, runId, actor.id, backend, question);
          return `[${result.actorName}] ${result.response}`;
        } catch (err) {
          return `Interview failed: ${(err as Error).message}`;
        }
      },
    },
    {
      name: "get_metrics",
      description: "Get the quantitative metrics summary for this simulation run.",
      execute: async () => {
        const lines: string[] = [];
        lines.push(`Rounds: ${metrics.rounds_completed}, Posts: ${metrics.total_posts}, Actions: ${metrics.total_actions}`);
        lines.push(`Avg active actors: ${metrics.avg_active_actors.toFixed(1)}`);
        lines.push(`Tiers: A=${metrics.tier_breakdown.tier_a_calls}, B=${metrics.tier_breakdown.tier_b_calls}, C=${metrics.tier_breakdown.tier_c_actions}`);

        if (metrics.sentiment_curves.length > 0) {
          lines.push("\nNarrative sentiment:");
          for (const s of metrics.sentiment_curves.slice(0, 5)) {
            lines.push(`  ${s.topic}: sentiment=${s.dominant_sentiment.toFixed(2)}, intensity=${s.intensity.toFixed(2)}`);
          }
        }

        if (metrics.top_actors_by_reach.length > 0) {
          lines.push("\nTop actors:");
          for (const a of metrics.top_actors_by_reach.slice(0, 5)) {
            lines.push(`  ${a.actor_name} (${a.cognition_tier}): reach=${a.total_reach}`);
          }
        }

        return lines.join("\n");
      },
    },
    {
      name: "get_actor_context",
      description: "Get the full context (beliefs, posts, memories) for a specific actor.",
      execute: async (actorName: string) => {
        try {
          const actor = resolveActorByName(store, runId, actorName);
          const context = store.queryActorContext(actor.id, runId);
          return formatActorContext(context);
        } catch (err) {
          return `Context lookup failed: ${(err as Error).message}`;
        }
      },
    },
  ];
}

// ═══════════════════════════════════════════════════════
// REACT ORCHESTRATOR
// ═══════════════════════════════════════════════════════

const AGENT_SYSTEM = `You are an investigative analyst reviewing a completed social simulation.

You have access to these tools:
- query_simulation: Ask natural-language questions about the simulation database
- interview_actor: Interview a simulated actor (format: "ActorName: question")
- get_metrics: Get quantitative metrics for the run
- get_actor_context: Get full context for an actor

Your analysis process:
1. THOUGHT: Form a hypothesis about the simulation dynamics
2. TOOL: Use a tool to gather evidence
3. OBSERVATION: Note what you learned
4. Repeat steps 1-3 until you have enough evidence
5. SYNTHESIS: Write your final analysis

Respond in this exact format for each step:
THOUGHT: [your reasoning]
TOOL: [tool_name] [input]
or
SYNTHESIS: [your final analysis]

Be thorough but concise. Interview at least 2 actors. Query the database for quantitative evidence.`;

/**
 * Run the ReportAgent analysis loop.
 *
 * The agent iterates through ReACT steps until it produces a synthesis
 * or hits the max step limit.
 */
export async function runReportAgent(
  store: GraphStore,
  llm: LLMClient,
  backend: CognitionBackend,
  input: ReportAgentInput
): Promise<ReportAgentOutput> {
  const { runId, objective, maxSteps = 5 } = input;
  const metrics = computeMetrics(store, runId);
  const schema = extractSchema(store);
  const tools = buildAgentTools(store, llm, backend, runId, metrics, schema);
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  const steps: ReportAgentStep[] = [];
  const actorsInterviewed: string[] = [];
  let queriesExecuted = 0;
  let synthesis = "";

  // Build conversation history for the agent
  const conversationHistory: string[] = [
    `OBJECTIVE: ${objective}`,
    "",
    `Available tools: ${tools.map((t) => `${t.name} (${t.description})`).join("\n")}`,
    "",
  ];

  for (let step = 0; step < maxSteps; step++) {
    const prompt = conversationHistory.join("\n") + "\n\nNext step:";

    let response: string;
    try {
      const result = await llm.complete("report", prompt, {
        system: AGENT_SYSTEM,
        temperature: 0.3,
        maxTokens: 1024,
      });
      response = result.content.trim();
    } catch {
      steps.push({ type: "thought", content: "LLM call failed, proceeding to synthesis." });
      break;
    }

    // Parse the response
    if (response.startsWith("SYNTHESIS:")) {
      synthesis = response.slice("SYNTHESIS:".length).trim();
      steps.push({ type: "synthesis", content: synthesis });
      break;
    }

    // Parse THOUGHT
    const thoughtMatch = response.match(/^THOUGHT:\s*(.+?)(?=\nTOOL:|\n*$)/s);
    if (thoughtMatch) {
      steps.push({ type: "thought", content: thoughtMatch[1].trim() });
      conversationHistory.push(`THOUGHT: ${thoughtMatch[1].trim()}`);
    }

    // Parse TOOL call
    const toolMatch = response.match(/TOOL:\s*(\w+)\s*(.*)/);
    if (toolMatch) {
      const toolName = toolMatch[1];
      const toolInput = toolMatch[2].trim();
      const tool = toolMap.get(toolName);

      steps.push({
        type: "tool",
        content: `${toolName}: ${toolInput}`,
        toolName,
        toolInput,
      });
      conversationHistory.push(`TOOL: ${toolName} ${toolInput}`);

      if (tool) {
        const observation = await tool.execute(toolInput);
        steps.push({ type: "observation", content: observation });
        conversationHistory.push(`OBSERVATION: ${observation}`);

        if (toolName === "interview_actor") {
          const actorName = toolInput.split(":")[0]?.trim();
          if (actorName && !actorsInterviewed.includes(actorName)) {
            actorsInterviewed.push(actorName);
          }
        }
        if (toolName === "query_simulation") {
          queriesExecuted++;
        }
      } else {
        const err = `Unknown tool: ${toolName}`;
        steps.push({ type: "observation", content: err });
        conversationHistory.push(`OBSERVATION: ${err}`);
      }
    }

    // If neither THOUGHT, TOOL, nor SYNTHESIS was parsed, treat as synthesis
    if (!thoughtMatch && !toolMatch && !response.startsWith("SYNTHESIS:")) {
      synthesis = response;
      steps.push({ type: "synthesis", content: synthesis });
      break;
    }
  }

  // If we hit max steps without synthesis, force one
  if (!synthesis) {
    const finalPrompt = conversationHistory.join("\n") +
      "\n\nYou've reached the analysis limit. Write your SYNTHESIS now:";

    try {
      const result = await llm.complete("report", finalPrompt, {
        system: AGENT_SYSTEM,
        temperature: 0.3,
        maxTokens: 2048,
      });
      synthesis = result.content.replace(/^SYNTHESIS:\s*/i, "").trim();
    } catch {
      synthesis = "Analysis incomplete — unable to generate final synthesis.";
    }
    steps.push({ type: "synthesis", content: synthesis });
  }

  // Extract key findings from synthesis
  const keyFindings = extractKeyFindings(synthesis);

  return {
    objective,
    steps,
    synthesis,
    keyFindings,
    actorsInterviewed,
    queriesExecuted,
  };
}

// ═══════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════

function extractKeyFindings(synthesis: string): string[] {
  // Try to extract bullet points or numbered items
  const lines = synthesis.split("\n").filter((l) => l.trim());
  const findings: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Match bullet points or numbered lists
    if (/^[-•*]\s+/.test(trimmed) || /^\d+[.)]\s+/.test(trimmed)) {
      findings.push(trimmed.replace(/^[-•*\d.)]+\s+/, ""));
    }
  }

  // If no structured findings, take the first 3 sentences
  if (findings.length === 0) {
    const sentences = synthesis
      .split(/[.!?]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 20);
    return sentences.slice(0, 3);
  }

  return findings.slice(0, 5);
}
