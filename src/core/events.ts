import { Database } from "bun:sqlite";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { getDataDir } from "./types.js";
import { log } from "./logger.js";

const DB_FILENAME = "dashboard.db";
const RETENTION_DAYS = 90;

export interface EventData {
  event: string;
  project?: string;
  project_hash?: string;
  session_id?: string;
  scope?: string;
  count?: number;
  query?: string;
  tags?: string[];
  memory_id?: string;
  content_snippet?: string;
  strength?: number;
  duration_ms?: number;
  error?: string;
  merges?: number;
  prunes?: number;
  generalizations?: number;
}

let db: Database | null = null;
let enabled: boolean | null = null;

/** Check if dashboard/events are enabled in config. */
function isEnabled(): boolean {
  if (enabled !== null) return enabled;
  try {
    const configPath = join(getDataDir(), "config.json");
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      enabled = config.dashboard === true;
    } else {
      enabled = false;
    }
  } catch {
    enabled = false;
  }
  return enabled;
}

/** Get or create the SQLite database. */
function getDb(): Database | null {
  if (!isEnabled()) return null;
  if (db) return db;

  try {
    const dbPath = join(getDataDir(), DB_FILENAME);
    db = new Database(dbPath);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA busy_timeout=3000");
    initSchema(db);
    return db;
  } catch (err) {
    log("warn", `Events DB init failed: ${err instanceof Error ? err.message : String(err)}`);
    enabled = false;
    return null;
  }
}

function initSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      event TEXT NOT NULL,
      project TEXT,
      project_hash TEXT,
      session_id TEXT,
      scope TEXT,
      count INTEGER,
      query TEXT,
      tags TEXT,
      memory_id TEXT,
      content_snippet TEXT,
      strength REAL,
      duration_ms INTEGER,
      error TEXT,
      merges INTEGER,
      prunes INTEGER,
      generalizations INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
    CREATE INDEX IF NOT EXISTS idx_events_event ON events(event);
    CREATE INDEX IF NOT EXISTS idx_events_project ON events(project);

    CREATE TABLE IF NOT EXISTS daily_stats (
      date TEXT NOT NULL,
      project TEXT NOT NULL,
      extractions INTEGER DEFAULT 0,
      memories_created INTEGER DEFAULT 0,
      recalls INTEGER DEFAULT 0,
      stores INTEGER DEFAULT 0,
      reinforcements INTEGER DEFAULT 0,
      forgets INTEGER DEFAULT 0,
      duplicates_caught INTEGER DEFAULT 0,
      errors INTEGER DEFAULT 0,
      PRIMARY KEY (date, project)
    );
  `);
}

/** Record an event. No-op if dashboard is disabled. */
export function recordEvent(data: EventData): void {
  const database = getDb();
  if (!database) return;

  try {
    const stmt = database.prepare(`
      INSERT INTO events (ts, event, project, project_hash, session_id, scope,
        count, query, tags, memory_id, content_snippet, strength,
        duration_ms, error, merges, prunes, generalizations)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      new Date().toISOString(),
      data.event,
      data.project ?? null,
      data.project_hash ?? null,
      data.session_id ?? null,
      data.scope ?? null,
      data.count ?? null,
      data.query ?? null,
      data.tags ? JSON.stringify(data.tags) : null,
      data.memory_id ?? null,
      data.content_snippet ?? null,
      data.strength ?? null,
      data.duration_ms ?? null,
      data.error ?? null,
      data.merges ?? null,
      data.prunes ?? null,
      data.generalizations ?? null,
    );
  } catch (err) {
    // Never let event logging break the main flow
    log("warn", `Event record failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Record the outcome of an identity rewrite — one definition shared by every
 * consolidation entry point (detached runner, MCP tool) so the dashboard's
 * identity history can't diverge by code path. Notes go in content_snippet;
 * the pre-write backup dir goes in `query` (the free text column) until the
 * dashboard grows a dedicated view.
 */
export function recordIdentityRewrite(
  idn: { rewritten: boolean; notes: string; backupPath?: string },
  project: string,
  project_hash: string,
): void {
  if (!idn.rewritten && !idn.notes.startsWith("failed:")) return; // no-op runs (no deltas) are not events
  recordEvent({
    event: "identity_rewrite",
    project,
    project_hash,
    content_snippet: idn.notes.slice(0, 300),
    query: idn.backupPath,
    error: idn.rewritten ? undefined : idn.notes.slice(0, 300),
  });
}

/** Roll up detailed events into daily_stats. Called by dashboard server. */
export function rollupDailyStats(database?: Database): void {
  const db_ = database ?? getDb();
  if (!db_) return;

  db_.exec(`
    INSERT OR REPLACE INTO daily_stats (date, project, extractions, memories_created,
      recalls, stores, reinforcements, forgets, duplicates_caught, errors)
    SELECT
      substr(ts, 1, 10) AS date,
      COALESCE(project, '_global') AS project,
      SUM(CASE WHEN event = 'extract' THEN 1 ELSE 0 END),
      SUM(CASE WHEN event = 'extract' THEN COALESCE(count, 0) ELSE 0 END),
      SUM(CASE WHEN event = 'recall' THEN 1 ELSE 0 END),
      SUM(CASE WHEN event = 'store' THEN 1 ELSE 0 END),
      SUM(CASE WHEN event = 'reinforce' THEN 1 ELSE 0 END),
      SUM(CASE WHEN event = 'forget' THEN 1 ELSE 0 END),
      SUM(CASE WHEN event = 'dedup' THEN COALESCE(count, 0) ELSE 0 END),
      SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END)
    FROM events
    GROUP BY date, project
  `);
}

/** Prune events older than RETENTION_DAYS. Called by dashboard server. */
export function pruneOldEvents(database?: Database): void {
  const db_ = database ?? getDb();
  if (!db_) return;

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString();
  db_.prepare("DELETE FROM events WHERE ts < ?").run(cutoff);
}

/** Close the database connection. */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/** Reset enabled cache (for testing). */
export function resetEventsConfig(): void {
  enabled = null;
}
