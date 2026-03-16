/**
 * shell.ts — Conversational REPL for the PublicMachina social simulation engine
 *
 * Provides an interactive shell that supports:
 *   - Natural language queries (translated to SQL via LLM)
 *   - Raw SQL SELECT queries
 *   - Actor interviews (via cognition backend)
 *   - CKP agent export
 *
 * CRITICAL: All SQL goes through store.executeReadOnlySql().
 * Never access store.db directly.
 */

import type { GraphStore } from "./db.js";
import type { LLMClient } from "./llm.js";
import type { CognitionBackend } from "./cognition.js";
import { appendAssistantMessage, type AssistantSession } from "./assistant-session.js";
import { resolveActorByName, interviewActor } from "./interview.js";
import { exportAgent } from "./ckp.js";
import type { SimConfig } from "./config.js";
import { handleModelCommand as runModelCommand } from "./model-command.js";
import {
  executeQuery,
  extractSchema,
  formatTable,
  nlToSql,
  type TableSchema,
} from "./query-service.js";

export { executeQuery, extractSchema, formatTable, nlToSql, type TableSchema } from "./query-service.js";

// ═══════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════

export interface ShellContext {
  store: GraphStore;
  runId: string;
  llm?: LLMClient;
  backend?: CognitionBackend;
  assistantSession?: AssistantSession;
  config?: SimConfig;
  configPath?: string;
  onConfigUpdate?: (config: SimConfig) => Promise<void>;
  onAssistantClear?: () => Promise<AssistantSession | undefined>;
}

export interface ShellIO {
  prompt(text: string): void;
  output(text: string): void;
  error(text: string): void;
  readline(): Promise<string>;
  close(): void;
}

export type CommandType = "interview" | "export" | "help" | "exit" | "query" | "model" | "clear";

export interface ParsedCommand {
  type: CommandType;
  args: string;
}

// ═══════════════════════════════════════════════════════
// classifyIntent
// ═══════════════════════════════════════════════════════

export function classifyIntent(input: string): ParsedCommand {
  const trimmed = input.trim();

  if (/^(interview|talk\s+to)\s+/i.test(trimmed)) {
    const args = trimmed.replace(/^(interview|talk\s+to)\s+/i, "").trim();
    return { type: "interview", args };
  }

  if (/^export\s+/i.test(trimmed)) {
    const args = trimmed.replace(/^export\s+/i, "").trim();
    return { type: "export", args };
  }

  if (/^(help|\?)$/i.test(trimmed)) {
    return { type: "help", args: "" };
  }

  if (/^\/model(?:\s+.*)?$/i.test(trimmed)) {
    const args = trimmed.replace(/^\/model/i, "").trim();
    return { type: "model", args };
  }

  if (/^\/clear$/i.test(trimmed)) {
    return { type: "clear", args: "" };
  }

  if (/^(\/exit|quit|exit)$/i.test(trimmed)) {
    return { type: "exit", args: "" };
  }

  return { type: "query", args: trimmed };
}

// ═══════════════════════════════════════════════════════
// startShell
// ═══════════════════════════════════════════════════════

export async function startShell(ctx: ShellContext, io: ShellIO): Promise<void> {
  const { store, runId } = ctx;

  const run = store.getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);

  const summary = store.getRunRoundSummary(runId);
  const actors = store.getActorsByRun(runId);

  io.output(`PublicMachina Shell — Run ${runId}\n`);
  io.output(`  ${actors.length} actors, ${summary.roundsCompleted} rounds, ${summary.totalPosts} posts\n`);
  io.output(`  Type "help" for commands, "exit" to quit.\n\n`);

  const schema = extractSchema(store);

  while (true) {
    io.prompt("publicmachina> ");
    let input: string;
    try {
      input = await io.readline();
    } catch {
      break; // EOF or readline closed
    }

    if (!input.trim()) continue;

    const cmd = classifyIntent(input);
    if (ctx.assistantSession) {
      appendAssistantMessage(ctx.assistantSession, "user", input);
    }

    try {
      switch (cmd.type) {
        case "exit":
          if (ctx.assistantSession) {
            appendAssistantMessage(ctx.assistantSession, "assistant", "Goodbye.");
          }
          io.output("Goodbye.\n");
          io.close();
          return;

        case "help":
          io.output("Commands:\n");
          io.output("  interview <actor>  — Interview a simulated actor\n");
          io.output("  export <actor>     — Export actor as CKP bundle\n");
          io.output("  /model             — Show or change provider/model\n");
          io.output("  /clear             — Start a fresh shell conversation without deleting durable memory\n");
          io.output("  help               — Show this help\n");
          io.output("  exit               — Quit shell\n");
          io.output("  <anything else>    — Natural language query (→ SQL)\n");
          if (ctx.assistantSession) {
            appendAssistantMessage(ctx.assistantSession, "assistant", "Displayed the available shell commands.");
          }
          break;

        case "model":
          await handleModelCommand(ctx, io, cmd.args);
          break;

        case "clear":
          await handleClearCommand(ctx, io);
          break;

        case "interview": {
          if (!ctx.backend) {
            io.error("No cognition backend configured for interviews.\n");
            break;
          }
          const actor = resolveActorByName(store, runId, cmd.args);
          const result = await interviewActor(store, runId, actor.id, ctx.backend, "Tell me about yourself.");
          io.output(`${result.actorName}: ${result.response}\n`);
          if (ctx.assistantSession) {
            appendAssistantMessage(
              ctx.assistantSession,
              "assistant",
              `Interviewed ${result.actorName}: ${result.response}`
            );
          }
          break;
        }

        case "export": {
          const actor = resolveActorByName(store, runId, cmd.args);
          const exportResult = exportAgent(store, runId, actor.id, `./ckp-export-${actor.handle ?? actor.id}`);
          io.output(`Exported ${actor.name} to ${exportResult.outDir}\n`);
          if (ctx.assistantSession) {
            appendAssistantMessage(
              ctx.assistantSession,
              "assistant",
              `Exported ${actor.name} to ${exportResult.outDir}.`
            );
          }
          break;
        }

        case "query": {
          if (ctx.llm && ctx.llm.hasProvider("report")) {
            const sql = await nlToSql(ctx.llm, schema, cmd.args);
            io.output(`SQL: ${sql}\n`);
            const { columns, rows } = executeQuery(store, sql);
            io.output(formatTable(columns, rows));
            io.output(`(${rows.length} rows)\n`);
            if (ctx.assistantSession) {
              appendAssistantMessage(
                ctx.assistantSession,
                "assistant",
                `Translated the request to SQL and returned ${rows.length} rows.`
              );
            }
          } else {
            // Try as raw SQL if it looks like SELECT
            if (/^\s*SELECT\b/i.test(cmd.args)) {
              const { columns, rows } = executeQuery(store, cmd.args);
              io.output(formatTable(columns, rows));
              io.output(`(${rows.length} rows)\n`);
              if (ctx.assistantSession) {
                appendAssistantMessage(
                  ctx.assistantSession,
                  "assistant",
                  `Executed a read-only SQL query and returned ${rows.length} rows.`
                );
              }
            } else {
              io.error("No LLM configured for natural language queries. Use raw SQL (SELECT ...) or configure a report provider.\n");
              if (ctx.assistantSession) {
                appendAssistantMessage(
                  ctx.assistantSession,
                  "assistant",
                  "Natural-language query failed because no report provider is configured."
                );
              }
            }
          }
          break;
        }
      }
    } catch (err) {
      io.error(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
      if (ctx.assistantSession) {
        appendAssistantMessage(
          ctx.assistantSession,
          "assistant",
          `Shell error: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }
}

async function handleModelCommand(
  ctx: ShellContext,
  io: ShellIO,
  args: string
): Promise<void> {
  await runModelCommand(ctx, io, args);
}

async function handleClearCommand(
  ctx: ShellContext,
  io: ShellIO
): Promise<void> {
  if (!ctx.onAssistantClear) {
    io.error("Conversation reset is unavailable in this shell.\n");
    return;
  }

  const nextSession = await ctx.onAssistantClear();
  ctx.assistantSession = nextSession;
  io.output("Started a fresh shell conversation. Durable memory and simulation history were kept.\n");
}
