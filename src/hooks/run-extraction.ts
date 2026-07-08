import { basename } from "node:path";
import { createStore } from "../core/store.js";
import { extractMemories } from "../core/salience.js";
import { applyInterference } from "../core/interference.js";
import { getWeights, getWeightsPromptHint } from "../core/salience-weights.js";
import { generateId, projectHash } from "../core/types.js";
import { getCurrentActiveDay } from "../core/active-day.js";
import { claimBuffer, clearClaim, restoreBuffer, restoreBufferText, lastSessionInBuffer, splitBufferIntoChunks, countSpanHeaders } from "../core/buffer.js";
import { loadConfig } from "../core/config.js";
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
      const config = loadConfig();
      const sessionId = lastSessionInBuffer(content) ?? "buffer";
      const existingMemories = await store.getRecentAndStrong(sessionId);
      const weights = await getWeights(store);
      const weightsHint = getWeightsPromptHint(weights);

      // Chunk the arc on span-header boundaries so each call's OUTPUT fits
      // max_tokens — one call over an arbitrarily large buffer used to truncate
      // the JSON and fail, re-buffering the whole thing so it only grew. Chunks
      // extract and fail INDEPENDENTLY: successful chunks' memories are kept,
      // only the failed chunks' raw text goes back to the buffer.
      const chunks = splitBufferIntoChunks(content, config.extractChunkBytes);
      const newMemories: Awaited<ReturnType<typeof extractMemories>> = [];
      const failedText: string[] = [];
      const chunkErrors: string[] = [];
      for (const chunk of chunks) {
        // A single span larger than the budget is its own chunk — extract it
        // alone with a raised budget; if it STILL truncates it fails like any
        // other chunk (logged + restored) and the rest of the arc proceeds.
        const oversized = countSpanHeaders(chunk) <= 1 && Buffer.byteLength(chunk, "utf-8") > config.extractChunkBytes;
        try {
          const mems = await extractMemories(chunk, existingMemories, "transcript", weightsHint, oversized ? 16000 : 8000);
          newMemories.push(...mems);
        } catch (chunkErr) {
          const cmsg = chunkErr instanceof Error ? chunkErr.message : String(chunkErr);
          failedText.push(chunk);
          chunkErrors.push(cmsg);
          log("warn", `Extraction chunk failed (${Buffer.byteLength(chunk, "utf-8")}B${oversized ? ", oversized single span" : ""}), text restored: ${cmsg}`);
        }
      }

      if (newMemories.length === 0 && chunkErrors.length === 0) {
        recordEvent({ event: "extract", project, project_hash, session_id: sessionId, count: 0, duration_ms: Date.now() - t0 });
        log("info", `Extraction: nothing durable in ${Math.round(content.length / 1024)}KB buffer (a good answer)`);
      } else if (newMemories.length > 0) {
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

      // Buffer disposition: successful chunks are consumed, only the failed
      // chunks' raw text returns to the buffer (verbatim spans — a future flush
      // retries just those). Restore BEFORE clearing the claim so a crash in
      // the gap duplicates (dedup catches it) rather than loses experience.
      if (failedText.length > 0) {
        restoreBufferText(cwd, failedText.join(""));
        // Failed-chunk errors ride an extract event (like promotionFailure on
        // consolidate) so the session-start self-check surfaces the breakage —
        // a silent extraction failure looks identical to a quiet day.
        recordEvent({
          event: "extract", project, project_hash, session_id: sessionId, duration_ms: Date.now() - t0,
          error: `extraction: ${failedText.length}/${chunks.length} chunk(s) failed, ${newMemories.length} memories kept; last: ${chunkErrors[chunkErrors.length - 1]}`,
        });
        log("warn", `Extraction: ${failedText.length}/${chunks.length} chunk(s) failed; their text restored to the buffer for the next flush`);
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
