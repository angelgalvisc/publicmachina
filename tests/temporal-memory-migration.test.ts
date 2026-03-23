/**
 * temporal-memory-migration.test.ts — Tests for migration v5 (outbox tables)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { SCHEMA_SQL, CURRENT_SCHEMA_VERSION } from "../src/schema.js";
import { applyStoreMigrations } from "../src/migrations.js";

describe("migration v5 — temporal memory outbox", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
  });

  afterEach(() => {
    db.close();
  });

  it("fresh database creates outbox tables at current version", () => {
    db.exec(SCHEMA_SQL);
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);

    // Verify tables exist
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'temporal_memory%'`
      )
      .all() as Array<{ name: string }>;

    const tableNames = tables.map((t) => t.name).sort();
    expect(tableNames).toEqual([
      "temporal_memory_outbox",
      "temporal_memory_sync_state",
    ]);
  });

  it("migration v5 adds outbox tables to a v4 database", () => {
    // Create a v4-era database (without outbox tables)
    // Simulate by creating core tables and setting version to 4
    db.exec(`
      CREATE TABLE run_manifest (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        seed INTEGER NOT NULL DEFAULT 42,
        config_snapshot TEXT NOT NULL DEFAULT '{}',
        hypothesis TEXT,
        docs_hash TEXT,
        graph_revision_id TEXT NOT NULL DEFAULT '',
        total_rounds INTEGER,
        status TEXT DEFAULT 'running',
        resumed_from TEXT,
        replayed_from_run TEXT,
        replay_source_db TEXT,
        replay_started_at TEXT,
        version TEXT
      );
    `);
    db.pragma("user_version = 4");

    // Apply migrations
    applyStoreMigrations(db);

    // Verify version is now 5
    const version = db.pragma("user_version", { simple: true });
    expect(version).toBe(5);

    // Verify outbox table exists and has correct columns
    const outboxCols = db
      .prepare("PRAGMA table_info(temporal_memory_outbox)")
      .all() as Array<{ name: string }>;
    const colNames = outboxCols.map((c) => c.name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("run_id");
    expect(colNames).toContain("round_num");
    expect(colNames).toContain("episode_type");
    expect(colNames).toContain("payload_json");
    expect(colNames).toContain("synced_at");
    expect(colNames).toContain("sync_error");

    // Verify sync state table exists
    const syncCols = db
      .prepare("PRAGMA table_info(temporal_memory_sync_state)")
      .all() as Array<{ name: string }>;
    expect(syncCols.map((c) => c.name)).toContain("last_synced_round");
  });

  it("outbox insert and query works", () => {
    db.exec(SCHEMA_SQL);
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);

    // Insert a run for FK
    db.prepare(
      `INSERT INTO run_manifest (id, started_at, seed, config_snapshot, graph_revision_id)
       VALUES ('run-1', '2024-01-01', 42, '{}', 'rev-1')`
    ).run();

    // Insert outbox row
    db.prepare(
      `INSERT INTO temporal_memory_outbox (id, run_id, round_num, episode_type, payload_json)
       VALUES ('ep-1', 'run-1', 0, 'post_created', '{"content":"test"}')`
    ).run();

    // Query pending (synced_at IS NULL)
    const pending = db
      .prepare(
        `SELECT * FROM temporal_memory_outbox WHERE run_id = ? AND synced_at IS NULL`
      )
      .all("run-1") as Array<{ id: string; episode_type: string }>;
    expect(pending).toHaveLength(1);
    expect(pending[0].episode_type).toBe("post_created");

    // Mark as synced
    db.prepare(
      `UPDATE temporal_memory_outbox SET synced_at = datetime('now') WHERE id = ?`
    ).run("ep-1");

    // Pending should be empty now
    const afterSync = db
      .prepare(
        `SELECT * FROM temporal_memory_outbox WHERE run_id = ? AND synced_at IS NULL`
      )
      .all("run-1");
    expect(afterSync).toHaveLength(0);
  });

  it("sync state tracks last synced round", () => {
    db.exec(SCHEMA_SQL);
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);

    db.prepare(
      `INSERT INTO run_manifest (id, started_at, seed, config_snapshot, graph_revision_id)
       VALUES ('run-1', '2024-01-01', 42, '{}', 'rev-1')`
    ).run();

    // Insert sync state
    db.prepare(
      `INSERT INTO temporal_memory_sync_state (run_id, last_synced_round, last_success_at)
       VALUES ('run-1', 3, datetime('now'))`
    ).run();

    // Update
    db.prepare(
      `UPDATE temporal_memory_sync_state SET last_synced_round = 5, last_success_at = datetime('now')
       WHERE run_id = ?`
    ).run("run-1");

    const state = db
      .prepare(`SELECT * FROM temporal_memory_sync_state WHERE run_id = ?`)
      .get("run-1") as { last_synced_round: number };
    expect(state.last_synced_round).toBe(5);
  });

  it("migration is idempotent — running twice does not fail", () => {
    db.exec(`
      CREATE TABLE run_manifest (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        seed INTEGER NOT NULL DEFAULT 42,
        config_snapshot TEXT NOT NULL DEFAULT '{}',
        graph_revision_id TEXT NOT NULL DEFAULT ''
      );
    `);
    db.pragma("user_version = 4");

    // Apply twice
    applyStoreMigrations(db);
    applyStoreMigrations(db);

    const version = db.pragma("user_version", { simple: true });
    expect(version).toBe(5);
  });
});
