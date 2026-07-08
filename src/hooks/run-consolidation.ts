import { basename } from "node:path";
import { createStore } from "../core/store.js";
import { runConsolidation } from "../core/consolidation.js";
import { projectHash } from "../core/types.js";
import { log } from "../core/logger.js";
import { recordEvent, recordIdentityRewrite } from "../core/events.js";

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
    if (result.inbox) log("info", `Inbox folded: ${result.inbox.episodes} episode(s), ${result.inbox.facts} fact(s) from ${result.inbox.files} file(s)`);

    // Partial failures (gist promotion, inbox parse) ride the consolidate event
    // so the session-start self-check surfaces them — silence must never mask breakage.
    const failure = [result.promotionFailure, result.inboxFailure].filter(Boolean).join(" | ") || undefined;

    // A run that lost the lock race did no work — logging it as a consolidate
    // event would inflate the dashboard with phantom runs
    if (!result.notes.startsWith("Skipped:")) {
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
        ...(failure ? { error: failure } : {}),
      });
    }

    // Identity rewrite outcome — notes + backup path make consolidation's
    // judgment inspectable on the dashboard (before/after view).
    if (result.identity) recordIdentityRewrite(result.identity, project, project_hash);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", `Auto-consolidation failed: ${msg}`);
    recordEvent({ event: "consolidate", project, project_hash, duration_ms: Date.now() - t0, error: msg });
  }
  process.exit(0);
}

main();
