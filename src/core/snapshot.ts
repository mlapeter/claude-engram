/**
 * Memory history — full git-based snapshots of the data dir.
 *
 * The rotating JSON backups keep ~2 days of history; a bad consolidation or a
 * development bug could destroy memories permanently once they rotate out.
 * Git converts "backup" into history: every consolidation and identity rewrite
 * commits the entire store, so any past state is diffable and restorable.
 *
 * Tracked: memories, deep archives, identity (docs, deltas, backups),
 * episodes, config. Ignored: secrets (env), derived/operational churn
 * (embeddings, dashboard db, log, locks, cursors, meta, rotating backups).
 */

import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "./types.js";
import { loadConfig } from "./config.js";
import { log } from "./logger.js";

const GITIGNORE = `# engram data dir — memory history tracks the stores, not the machinery
env
engram.log
consolidation.lock
dashboard.db*
dashboard-server.log
backups/
**/briefing-cache.json
**/embeddings.json
**/cursor.json
**/meta.json
.DS_Store
`;

function git(args: string[], cwd: string): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", timeout: 30_000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

/**
 * Commit the current state of the data dir. Initializes the repository on
 * first use. Never throws — history is protection, not a dependency; a
 * machine without git just logs a warning and moves on.
 * Returns true if a commit was created (false also when nothing changed).
 */
export function commitMemorySnapshot(message: string): boolean {
  try {
    if (!loadConfig().memoryHistory) return false;
    const dir = getDataDir();
    if (!existsSync(dir)) return false;

    if (!existsSync(join(dir, ".git"))) {
      const init = git(["init", "-q"], dir);
      if (!init.ok) {
        log("warn", `Memory history: git init failed (is git installed?): ${init.out}`);
        return false;
      }
      // Repo-local identity — never depend on (or pollute) the user's git config
      git(["config", "user.name", "engram"], dir);
      git(["config", "user.email", "engram@localhost"], dir);
      writeFileSync(join(dir, ".gitignore"), GITIGNORE);
      log("info", "Memory history: initialized git repository in data dir");
    }

    git(["add", "-A"], dir);
    const commit = git(["commit", "-q", "-m", message], dir);
    if (commit.ok) {
      log("info", `Memory history: snapshot — ${message.split("\n")[0].slice(0, 100)}`);
      return true;
    }
    if (/nothing to commit/i.test(commit.out)) return false;
    log("warn", `Memory history: commit failed: ${commit.out.slice(0, 200)}`);
    return false;
  } catch (err) {
    log("warn", `Memory history: snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
