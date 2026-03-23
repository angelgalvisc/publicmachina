import Database from "better-sqlite3";
import { CURRENT_SCHEMA_VERSION } from "./schema.js";

export function applyStoreMigrations(db: Database.Database): void {
  const currentVersion = getSchemaVersion(db);
  const migrations: Array<{ version: number; apply: () => void }> = [
    {
      version: 1,
      apply: () => {
        ensureColumn(
          db,
          "posts",
          "post_kind",
          "ALTER TABLE posts ADD COLUMN post_kind TEXT DEFAULT 'post'"
        );
        ensureColumn(
          db,
          "posts",
          "is_deleted",
          "ALTER TABLE posts ADD COLUMN is_deleted INTEGER DEFAULT 0"
        );
        ensureColumn(db, "posts", "deleted_at", "ALTER TABLE posts ADD COLUMN deleted_at TEXT");
        ensureColumn(
          db,
          "posts",
          "moderation_status",
          "ALTER TABLE posts ADD COLUMN moderation_status TEXT DEFAULT 'none'"
        );
      },
    },
    {
      version: 2,
      apply: () => {
        ensureColumn(
          db,
          "snapshots",
          "fired_triggers",
          "ALTER TABLE snapshots ADD COLUMN fired_triggers TEXT DEFAULT '[]'"
        );
      },
    },
    {
      version: 3,
      apply: () => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS run_scaffolds (
            run_id TEXT PRIMARY KEY,
            scaffold_json TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (run_id) REFERENCES run_manifest(id)
          );

          CREATE TABLE IF NOT EXISTS decision_traces (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            round_num INTEGER NOT NULL,
            actor_id TEXT NOT NULL,
            route_tier TEXT NOT NULL,
            route_reason TEXT,
            search_eligible INTEGER DEFAULT 0,
            search_selected INTEGER DEFAULT 0,
            search_queries TEXT,
            search_request_ids TEXT,
            request_hash TEXT,
            model_id TEXT,
            prompt_version TEXT,
            raw_decision TEXT,
            normalized_decision TEXT,
            final_action TEXT,
            normalization_reason TEXT,
            tier_c_rule_reason TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (run_id) REFERENCES run_manifest(id),
            FOREIGN KEY (actor_id) REFERENCES actors(id)
          );

          CREATE INDEX IF NOT EXISTS idx_decision_traces_run_round ON decision_traces(run_id, round_num);
          CREATE INDEX IF NOT EXISTS idx_decision_traces_actor ON decision_traces(run_id, actor_id, round_num DESC);
        `);
      },
    },
    {
      version: 4,
      apply: () => {
        ensureColumn(
          db,
          "run_manifest",
          "replayed_from_run",
          "ALTER TABLE run_manifest ADD COLUMN replayed_from_run TEXT"
        );
        ensureColumn(
          db,
          "run_manifest",
          "replay_source_db",
          "ALTER TABLE run_manifest ADD COLUMN replay_source_db TEXT"
        );
        ensureColumn(
          db,
          "run_manifest",
          "replay_started_at",
          "ALTER TABLE run_manifest ADD COLUMN replay_started_at TEXT"
        );
      },
    },
    {
      version: 5,
      apply: () => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS temporal_memory_outbox (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            round_num INTEGER NOT NULL,
            episode_type TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            synced_at TEXT,
            sync_error TEXT,
            FOREIGN KEY (run_id) REFERENCES run_manifest(id)
          );

          CREATE TABLE IF NOT EXISTS temporal_memory_sync_state (
            run_id TEXT PRIMARY KEY,
            last_synced_round INTEGER NOT NULL DEFAULT -1,
            last_success_at TEXT,
            last_error TEXT,
            FOREIGN KEY (run_id) REFERENCES run_manifest(id)
          );

          CREATE INDEX IF NOT EXISTS idx_temporal_outbox_pending
            ON temporal_memory_outbox(run_id, round_num, synced_at);
        `);
      },
    },
  ];

  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue;
    db.transaction(() => {
      migration.apply();
      setSchemaVersion(db, migration.version);
    })();
  }

  if (getSchemaVersion(db) < CURRENT_SCHEMA_VERSION) {
    setSchemaVersion(db, CURRENT_SCHEMA_VERSION);
  }
}

function ensureColumn(db: Database.Database, table: string, column: string, ddl: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) return;
  db.exec(ddl);
}

function getSchemaVersion(db: Database.Database): number {
  const row = db.pragma("user_version", { simple: true });
  return typeof row === "number" ? row : 0;
}

function setSchemaVersion(db: Database.Database, version: number): void {
  db.pragma(`user_version = ${version}`);
}
