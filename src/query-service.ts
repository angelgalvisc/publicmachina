/**
 * query-service.ts — Shared read-only query helpers for simulation databases.
 */

import type { GraphStore } from "./db.js";
import type { LLMClient } from "./llm.js";

export interface TableSchema {
  name: string;
  columns: Array<{ name: string; type: string }>;
}

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

export function executeQuery(
  store: GraphStore,
  sql: string
): { columns: string[]; rows: Array<Record<string, unknown>> } {
  if (!/^\s*SELECT\b/i.test(sql)) {
    throw new Error("Only SELECT queries are allowed");
  }
  const rows = store.executeReadOnlySql(sql);
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { columns, rows };
}

export function formatTable(
  columns: string[],
  rows: Array<Record<string, unknown>>
): string {
  if (columns.length === 0) return "(no results)\n";

  const widths = columns.map((col) => {
    const maxDataWidth = rows.reduce((max, row) => {
      const val = String(row[col] ?? "");
      return Math.max(max, val.length);
    }, 0);
    return Math.max(col.length, maxDataWidth);
  });

  const header = columns.map((col, i) => col.padEnd(widths[i])).join(" | ");
  const separator = widths.map((w) => "-".repeat(w)).join("-+-");
  const dataRows = rows.map((row) =>
    columns.map((col, i) => String(row[col] ?? "").padEnd(widths[i])).join(" | ")
  );

  return [header, separator, ...dataRows, ""].join("\n");
}

export async function nlToSql(
  llm: LLMClient,
  schema: TableSchema[],
  question: string
): Promise<string> {
  const schemaText = schema
    .map((table) => {
      const cols = table.columns.map((column) => `  ${column.name} ${column.type}`).join("\n");
      return `TABLE ${table.name}:\n${cols}`;
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

  let sql = response.content.trim();
  if (sql.startsWith("```sql")) sql = sql.slice(6);
  else if (sql.startsWith("```")) sql = sql.slice(3);
  if (sql.endsWith("```")) sql = sql.slice(0, -3);
  sql = sql.trim();

  if (!/^\s*SELECT\b/i.test(sql)) {
    throw new Error("LLM generated a non-SELECT query. Refusing to execute.");
  }

  return sql;
}
