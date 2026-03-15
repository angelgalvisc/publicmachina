/**
 * shell.ts — Conversational REPL for the SeldonClaw social simulation engine
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
import { resolveActorByName, interviewActor } from "./interview.js";
import { exportAgent } from "./ckp.js";

// ═══════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════

export interface ShellContext {
  store: GraphStore;
  runId: string;
  llm?: LLMClient;
  backend?: CognitionBackend;
}

export interface ShellIO {
  prompt(text: string): void;
  output(text: string): void;
  error(text: string): void;
  readline(): Promise<string>;
  close(): void;
}

export interface TableSchema {
  name: string;
  columns: Array<{ name: string; type: string }>;
}

export type CommandType = "interview" | "export" | "help" | "exit" | "query";

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

  if (/^(\/exit|quit|exit)$/i.test(trimmed)) {
    return { type: "exit", args: "" };
  }

  return { type: "query", args: trimmed };
}

// ═══════════════════════════════════════════════════════
// extractSchema
// ═══════════════════════════════════════════════════════

export function extractSchema(store: GraphStore): TableSchema[] {
  const tables = store.executeReadOnlySql(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ) as Array<{ name: string }>;

  const schemas: TableSchema[] = [];
  for (const table of tables) {
    const columns = store.executeReadOnlySql(
      `SELECT name, type FROM pragma_table_info('${table.name}') ORDER BY cid`
    ) as Array<{ name: string; type: string }>;
    schemas.push({ name: table.name, columns });
  }
  return schemas;
}

// ═══════════════════════════════════════════════════════
// executeQuery
// ═══════════════════════════════════════════════════════

export function executeQuery(
  store: GraphStore,
  sql: string
): { columns: string[]; rows: Array<Record<string, unknown>> } {
  const rows = store.executeReadOnlySql(sql);
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { columns, rows };
}

// ═══════════════════════════════════════════════════════
// formatTable
// ═══════════════════════════════════════════════════════

export function formatTable(
  columns: string[],
  rows: Array<Record<string, unknown>>
): string {
  if (columns.length === 0) return "(no results)\n";

  // Compute column widths
  const widths = columns.map((col) => {
    const maxDataWidth = rows.reduce((max, row) => {
      const val = String(row[col] ?? "");
      return Math.max(max, val.length);
    }, 0);
    return Math.max(col.length, maxDataWidth);
  });

  // Header
  const header = columns.map((col, i) => col.padEnd(widths[i])).join(" | ");
  const separator = widths.map((w) => "-".repeat(w)).join("-+-");

  // Rows
  const dataRows = rows.map((row) =>
    columns.map((col, i) => String(row[col] ?? "").padEnd(widths[i])).join(" | ")
  );

  return [header, separator, ...dataRows, ""].join("\n");
}

// ═══════════════════════════════════════════════════════
// nlToSql
// ═══════════════════════════════════════════════════════

export async function nlToSql(
  llm: LLMClient,
  schema: TableSchema[],
  question: string,
  history: Array<{ role: string; content: string }> = []
): Promise<string> {
  const schemaText = schema
    .map((t) => {
      const cols = t.columns.map((c) => `  ${c.name} ${c.type}`).join("\n");
      return `TABLE ${t.name}:\n${cols}`;
    })
    .join("\n\n");

  const system =
    `You are a SQL query generator for a social simulation database.\n\n` +
    `DATABASE SCHEMA:\n${schemaText}\n\n` +
    `RULES:\n` +
    `- Generate ONLY SELECT queries. Never INSERT, UPDATE, DELETE, DROP, or ALTER.\n` +
    `- Return ONLY the SQL query, no explanation, no markdown fences.\n` +
    `- Use appropriate JOINs when relating tables.\n` +
    `- Limit results to 50 rows unless asked otherwise.`;

  const response = await llm.complete("report", question, {
    system,
    temperature: 0.0,
    maxTokens: 512,
  });

  // Extract SQL — strip any accidental fences
  let sql = response.content.trim();
  if (sql.startsWith("```sql")) sql = sql.slice(6);
  else if (sql.startsWith("```")) sql = sql.slice(3);
  if (sql.endsWith("```")) sql = sql.slice(0, -3);
  sql = sql.trim();

  // Validate starts with SELECT
  if (!/^\s*SELECT\b/i.test(sql)) {
    throw new Error("LLM generated a non-SELECT query. Refusing to execute.");
  }

  return sql;
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

  io.output(`SeldonClaw Shell — Run ${runId}\n`);
  io.output(`  ${actors.length} actors, ${summary.roundsCompleted} rounds, ${summary.totalPosts} posts\n`);
  io.output(`  Type "help" for commands, "exit" to quit.\n\n`);

  const schema = extractSchema(store);

  while (true) {
    io.prompt("seldonclaw> ");
    let input: string;
    try {
      input = await io.readline();
    } catch {
      break; // EOF or readline closed
    }

    if (!input.trim()) continue;

    const cmd = classifyIntent(input);

    try {
      switch (cmd.type) {
        case "exit":
          io.output("Goodbye.\n");
          io.close();
          return;

        case "help":
          io.output("Commands:\n");
          io.output("  interview <actor>  — Interview a simulated actor\n");
          io.output("  export <actor>     — Export actor as CKP bundle\n");
          io.output("  help               — Show this help\n");
          io.output("  exit               — Quit shell\n");
          io.output("  <anything else>    — Natural language query (→ SQL)\n");
          break;

        case "interview": {
          if (!ctx.backend) {
            io.error("No cognition backend configured for interviews.\n");
            break;
          }
          const actor = resolveActorByName(store, runId, cmd.args);
          const result = await interviewActor(store, runId, actor.id, ctx.backend, "Tell me about yourself.");
          io.output(`${result.actorName}: ${result.response}\n`);
          break;
        }

        case "export": {
          const actor = resolveActorByName(store, runId, cmd.args);
          const exportResult = exportAgent(store, runId, actor.id, `./ckp-export-${actor.handle ?? actor.id}`);
          io.output(`Exported ${actor.name} to ${exportResult.outDir}\n`);
          break;
        }

        case "query": {
          if (ctx.llm && ctx.llm.hasProvider("report")) {
            const sql = await nlToSql(ctx.llm, schema, cmd.args);
            io.output(`SQL: ${sql}\n`);
            const { columns, rows } = executeQuery(store, sql);
            io.output(formatTable(columns, rows));
            io.output(`(${rows.length} rows)\n`);
          } else {
            // Try as raw SQL if it looks like SELECT
            if (/^\s*SELECT\b/i.test(cmd.args)) {
              const { columns, rows } = executeQuery(store, cmd.args);
              io.output(formatTable(columns, rows));
              io.output(`(${rows.length} rows)\n`);
            } else {
              io.error("No LLM configured for natural language queries. Use raw SQL (SELECT ...) or configure a report provider.\n");
            }
          }
          break;
        }
      }
    } catch (err) {
      io.error(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
}
