import { basename } from "node:path";
import { createStore } from "../core/store.js";
import { extractMemories } from "../core/salience.js";
import { applyInterference } from "../core/interference.js";
import { getWeights, getWeightsPromptHint } from "../core/salience-weights.js";
import { generateId, projectHash } from "../core/types.js";
import { getCurrentActiveDay } from "../core/active-day.js";
import { claimBuffer, clearClaim, restoreBuffer, lastSessionInBuffer } from "../core/buffer.js";
import { generateBriefing } from "../core/briefing.js";
import { log } from "../core/logger.js";
import { recordEvent } from "../core/events.js";

/**
 * Detached extraction runner — the selection half of encoding.
 *
 * Hooks append raw spans to a durable buffer in microseconds; this runner,
 * spawned at natural boundaries (buffer size/age, PreCompact, SessionEnd,
 * wake), claims the whole buffer and makes ONE judgment call over the arc.
 * No deadline: it runs outside every hook timeout. Failure restores the
 * buffer — experience is never lost between encoding and selection.
 *
 * Usage: bun run-extraction.ts <cwd> [--then-briefing]
 */
async function main() {
  const cwd = process.argv[2];
  const thenBriefing = process.argv.includes("--then-briefing");
  if (!cwd) {
    log("error", "run-extraction: missing cwd argument");
    process.exit(1);
  }

  const t0 = Date.now();
  const store = createStore(cwd);
  const project = basename(cwd);
  const project_hash = projectHash(cwd);

  const content = claimBuffer(cwd);
  if (content !== null) {
    try {
      const sessionId = lastSessionInBuffer(content) ?? "buffer";
      const existingMemories = await store.getRecentAndStrong(sessionId);
      const weights = await getWeights(store);
      const weightsHint = getWeightsPromptHint(weights);

      const newMemories = await extractMemories(content, existingMemories, "transcript", weightsHint);

      if (newMemories.length === 0) {
        recordEvent({ event: "extract", project, project_hash, session_id: sessionId, count: 0, duration_ms: Date.now() - t0 });
        log("info", `Extraction: nothing durable in ${Math.round(content.length / 1024)}KB buffer (a good answer)`);
      } else {
        const dupIndices = await store.checkDuplicates(newMemories.map((m) => m.content));
        const isValidUpdate = (u: string | null) => u != null && /^m_\d+_\w+$/.test(u);
        const deduped = newMemories.filter((m, i) => !dupIndices.has(i) || isValidUpdate(m.updates));
        if (dupIndices.size > 0) {
          recordEvent({ event: "dedup", project, project_hash, session_id: sessionId, count: dupIndices.size });
        }

        if (deduped.length > 0) {
          const activeDay = getCurrentActiveDay();
          const fullMemories = deduped.map((m) => ({
            id: generateId(),
            content: m.content,
            scope: m.scope,
            register: m.register,
            memory_type: "episodic" as const,
            salience: m.salience,
            tags: m.tags,
            access_count: 0,
            last_accessed: null,
            created_at: new Date().toISOString(),
            created_active_day: activeDay > 0 ? activeDay : null,
            consolidated: false,
            generalized: false,
            source_session: sessionId,
            updated_from: isValidUpdate(m.updates) ? m.updates : null,
          }));

          await store.add(fullMemories);
          const weakened = await applyInterference(fullMemories, existingMemories, store);
          log("info", `Extraction: stored ${fullMemories.length} memories from ${Math.round(content.length / 1024)}KB buffer${weakened > 0 ? `, weakened ${weakened} via interference` : ""}`);
          for (const m of fullMemories) {
            recordEvent({
              event: "extract", project, project_hash, session_id: sessionId,
              scope: m.scope, memory_id: m.id, content_snippet: m.content.slice(0, 80),
              tags: m.tags, duration_ms: Date.now() - t0,
            });
          }
        }
      }
      clearClaim(cwd);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      restoreBuffer(cwd); // experience goes back in the buffer for the next flush
      log("error", `Extraction failed (buffer restored): ${msg}`);
      recordEvent({ event: "extract", project, project_hash, duration_ms: Date.now() - t0, error: msg });
    }
  }

  // SessionEnd path: regenerate the briefing AFTER extraction so tomorrow's
  // wake-up includes today's final memories. Detached — no hook deadline.
  if (thenBriefing) {
    try {
      const allMemories = await store.loadAll();
      const lastCache = await store.loadBriefingCache();
      const briefing = await generateBriefing(allMemories, { cwd, projectName: project }, lastCache?.generatedAt);
      await store.saveBriefingCache(briefing, allMemories.length);
      log("info", `Extraction runner: cached briefing (${allMemories.length} memories)`);
    } catch (err) {
      log("warn", `Extraction runner: briefing failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  process.exit(0);
}

main();
