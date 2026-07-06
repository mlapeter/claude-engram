import { basename } from "node:path";
import { createStore } from "../core/store.js";
import { runConsolidation } from "../core/consolidation.js";
import { projectHash } from "../core/types.js";
import { log } from "../core/logger.js";
import { recordEvent } from "../core/events.js";

/**
 * Detached consolidation runner — spawned by the SessionStart hook.
 *
 * Consolidation used to run as a fire-and-forget promise inside the
 * SessionStart hook process. The pending API calls kept that process alive,
 * the hook wrapper's command substitution blocked on it, and Claude Code's
 * hook timeout killed the whole thing mid-run — every auto-consolidation died
 * partway, leaving a stale lock and unfolded identity deltas. Running in a
 * detached child lets the hook return instantly while consolidation finishes
 * on its own clock.
 */
async function main() {
  const cwd = process.argv[2];
  if (!cwd) {
    log("error", "run-consolidation: missing cwd argument");
    process.exit(1);
  }

  const t0 = Date.now();
  const store = createStore(cwd);
  const project = basename(cwd);
  const project_hash = projectHash(cwd);

  try {
    const result = await runConsolidation(store);
    log("info", `Auto-consolidation done: ${result.mergeCount} merges, ${result.generalizeCount} generalizations, ${result.pruneCount} prunes`);

    const after = (await store.loadAll()).length;
    recordEvent({
      event: "consolidate",
      project,
      project_hash,
      merges: result.mergeCount,
      prunes: result.pruneCount,
      generalizations: result.generalizeCount,
      count: after,
      duration_ms: Date.now() - t0,
    });

    // Identity rewrite outcome — notes + backup path make consolidation's
    // judgment inspectable on the dashboard (before/after view).
    const idn = result.identity;
    if (idn && (idn.rewritten || idn.notes.startsWith("failed:"))) {
      recordEvent({
        event: "identity_rewrite",
        project,
        project_hash,
        content_snippet: idn.notes.slice(0, 300),
        query: idn.backupPath,
        error: idn.rewritten ? undefined : idn.notes.slice(0, 300),
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", `Auto-consolidation failed: ${msg}`);
    recordEvent({ event: "consolidate", project, project_hash, duration_ms: Date.now() - t0, error: msg });
  }
  process.exit(0);
}

main();
