import type { HookInput } from "../core/types.js";
import { createStore, type MemoryStore } from "../core/store.js";
import { readTranscriptFromCursor } from "../core/transcript.js";
import { extractMemories } from "../core/salience.js";
import { generateId, projectHash } from "../core/types.js";
import type { TranscriptCursor } from "../core/types.js";
import { applyInterference } from "../core/interference.js";
import { getWeights, getWeightsPromptHint } from "../core/salience-weights.js";
import { log } from "../core/logger.js";
import { recordEvent } from "../core/events.js";
import { loadConfig } from "../core/config.js";
import { episodeBlockReason, EPISODE_MIN_CONTENT } from "../core/episodes.js";
import { withTimeout, TimeoutError, timeoutFromEnv } from "../core/async.js";
import { runHook } from "./harness.js";
import { basename } from "node:path";

const MIN_CONTENT_LENGTH = 200;

/** Watchdog over the world-layer (extraction + dedup + store) — a slow API call
 * must not hang the session close. The default must sit safely INSIDE the Stop
 * hook's external timeout (30s in install.sh / settings.json), or Claude Code
 * kills the hook before the graceful path can run. */
const EXTRACTION_TIMEOUT_MS = timeoutFromEnv("ENGRAM_EXTRACT_TIMEOUT_MS", 20_000);

/** Set when the watchdog has fired: the abandoned continuation must not keep
 * writing to the store after the hook has moved on (double-store + double-
 * interference on the next Stop's re-extraction). */
interface AbortToken {
  expired: boolean;
}

/** World layer: extract memories from new transcript content and store them. */
async function extractAndStore(
  store: MemoryStore,
  content: string,
  session_id: string,
  projectName: string,
  projHash: string,
  newCursor: TranscriptCursor,
  token: AbortToken,
): Promise<void> {
  // Load bounded dedup window (recent + session + strongest) instead of all memories
  const existingMemories = await store.getRecentAndStrong(session_id);

  // Compute learned salience weights for extraction calibration
  const weights = await getWeights(store);
  const weightsHint = getWeightsPromptHint(weights);

  // Extract new memories
  const extractStart = Date.now();
  const newMemories = await extractMemories(content, existingMemories, "transcript", weightsHint);

  if (newMemories.length === 0) {
    recordEvent({ event: "extract", project: projectName, project_hash: projHash, session_id, count: 0, duration_ms: Date.now() - extractStart });
    return;
  }

  // Post-extraction dedup: filter out near-duplicates of existing memories
  const dupIndices = await store.checkDuplicates(
    newMemories.map((m) => m.content),
  );
  // Only bypass dedup for genuine updates (valid memory ID), not malformed extraction output
  const isValidUpdate = (u: string | null) => u != null && /^m_\d+_\w+$/.test(u);
  const dedupedMemories = newMemories.filter((m, i) => !dupIndices.has(i) || isValidUpdate(m.updates));

  if (dupIndices.size > 0) {
    log("info", `Stop: filtered ${dupIndices.size} duplicate${dupIndices.size > 1 ? "s" : ""} (${dedupedMemories.length} unique)`);
    recordEvent({ event: "dedup", project: projectName, project_hash: projHash, session_id, count: dupIndices.size });
  }

  if (dedupedMemories.length === 0) return;

  const fullMemories = dedupedMemories.map((m) => ({
    id: generateId(),
    content: m.content,
    scope: m.scope,
    memory_type: "episodic" as const,
    salience: m.salience,
    tags: m.tags,
    access_count: 0,
    last_accessed: null,
    created_at: new Date().toISOString(),
    consolidated: false,
    generalized: false,
    source_session: session_id,
    updated_from: isValidUpdate(m.updates) ? m.updates : null,
  }));

  // Watchdog already fired? Don't write — the hook has recorded a failure and
  // will re-extract this span next Stop; storing now would double it.
  if (token.expired) return;

  await store.add(fullMemories);
  // Cursor advances the moment memories are durably stored, BEFORE interference:
  // if the watchdog fires during the remaining work, the next Stop must not
  // re-extract a span whose memories already landed.
  await store.saveCursor(newCursor);

  if (token.expired) return;
  const weakened = await applyInterference(fullMemories, existingMemories, store);
  log("info", `Stop: stored ${fullMemories.length} memories${weakened > 0 ? `, weakened ${weakened} via interference` : ""}`);

  for (const m of fullMemories) {
    recordEvent({
      event: "extract",
      project: projectName,
      project_hash: projHash,
      session_id,
      scope: m.scope,
      memory_id: m.id,
      content_snippet: m.content.slice(0, 80),
      tags: m.tags,
      duration_ms: Date.now() - extractStart,
    });
  }
}

/** Returns the block-decision JSON to emit, or null for a normal passthrough. */
async function main(input: HookInput): Promise<string | null> {
  // Anti-loop: if stop hook is already active, pass through immediately
  if (input.stop_hook_active) return null;

  const { session_id, transcript_path, cwd } = input;

  log("info", `Stop: session=${session_id}`);

  const store = createStore(cwd);
  const projectName = basename(cwd);
  const projHash = projectHash(cwd);

  // Load cursor and read new transcript content
  const cursor = await store.loadCursor();
  const { content, newCursor } = readTranscriptFromCursor(
    transcript_path,
    cursor,
    session_id,
  );

  // Skip if too little content
  if (content.length < MIN_CONTENT_LENGTH) {
    await store.saveCursor(newCursor);
    log("info", `Stop: skipped (content too short: ${content.length} chars)`);
    return null;
  }

  // World layer: extraction failure or timeout must NOT take the episode ask
  // down with it — the self-layer must not die when the world-layer does.
  const token: AbortToken = { expired: false };
  try {
    await withTimeout(
      extractAndStore(store, content, session_id, projectName, projHash, newCursor, token),
      EXTRACTION_TIMEOUT_MS,
      "Stop extraction",
    );
    await store.saveCursor(newCursor);
  } catch (err) {
    token.expired = true; // stop the abandoned continuation from writing
    const msg = err instanceof Error ? err.message : String(err);
    const kind = err instanceof TimeoutError ? "timed out" : "failed";
    // Cursor intentionally not saved (unless store.add already advanced it) —
    // unstored content is retried at the next Stop
    log("error", `Stop: extraction ${kind}, episode ask still runs: ${msg}`);
    recordEvent({ event: "extract", project: projectName, project_hash: projHash, session_id, error: msg });
  }

  // Episode self-dump: after extraction (successful or not), ask the session
  // model (the experiencer) to write its first-person episode. Blocks the stop
  // exactly once; the stop_hook_active guard makes the follow-up stop pass through.
  try {
    const config = loadConfig();
    if (config.episodeSelfDump && content.length >= EPISODE_MIN_CONTENT) {
      const reason = episodeBlockReason(session_id);
      if (reason) {
        log("info", `Stop: requested episode self-dump (session=${session_id})`);
        recordEvent({ event: "episode_request", project: projectName, project_hash: projHash, session_id });
        return JSON.stringify({ decision: "block", reason });
      }
    }
  } catch (err) {
    log("warn", `Stop: episode self-dump check failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

runHook("stop", main);
