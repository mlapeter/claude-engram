import type { HookInput } from "../core/types.js";
import { createStore } from "../core/store.js";
import { readTranscriptFromCursor } from "../core/transcript.js";
import { log } from "../core/logger.js";
import { recordEvent } from "../core/events.js";
import { loadConfig } from "../core/config.js";
import { episodeBlockReason, EPISODE_MIN_CONTENT } from "../core/episodes.js";
import { appendToBuffer, bufferStats } from "../core/buffer.js";
import { runHook, spawnDetached } from "./harness.js";
import { basename } from "node:path";
import { projectHash } from "../core/types.js";

const MIN_CONTENT_LENGTH = 200;

/**
 * Stop hook — the ENCODING half only, and deliberately dumb: append the
 * turn's span to the durable buffer (microseconds, no API call, nothing to
 * time out), then decide whether the SELECTION half — the detached extraction
 * runner — should fire. Judgment lives outside the hot path.
 */
async function main(input: HookInput): Promise<string | null> {
  // Anti-loop: if stop hook is already active, pass through immediately
  if (input.stop_hook_active) return null;

  const { session_id, transcript_path, cwd } = input;

  log("info", `Stop: session=${session_id}`);

  const store = createStore(cwd);
  const cursor = await store.loadCursor();
  const { content, newCursor } = readTranscriptFromCursor(transcript_path, cursor, session_id);

  if (content.length >= MIN_CONTENT_LENGTH) {
    // Encode: durable append, cursor advances immediately — the buffer file
    // survives crashes, so there are no retry semantics to manage here
    appendToBuffer(cwd, session_id, content);
  }
  await store.saveCursor(newCursor);

  // Flush triggers: enough accumulated experience, or the oldest of it is
  // going stale. The runner claims the buffer atomically; concurrent spawns
  // are harmless no-ops.
  const config = loadConfig();
  const stats = bufferStats(cwd);
  const stale = stats.oldestMs != null && Date.now() - stats.oldestMs > config.bufferFlushHours * 3600_000;
  if (stats.bytes >= config.bufferFlushBytes || (stale && stats.bytes >= MIN_CONTENT_LENGTH)) {
    spawnDetached("run-extraction.ts", [cwd]);
  }

  // Episode self-dump: gate on the SESSION's accumulated experience (this
  // span plus whatever is still buffered), not just the final turn's length.
  try {
    if (config.episodeSelfDump && content.length + stats.bytes >= EPISODE_MIN_CONTENT && content.length >= MIN_CONTENT_LENGTH) {
      const reason = episodeBlockReason(session_id);
      if (reason) {
        log("info", `Stop: requested episode self-dump (session=${session_id})`);
        recordEvent({ event: "episode_request", project: basename(cwd), project_hash: projectHash(cwd), session_id });
        return JSON.stringify({ decision: "block", reason });
      }
    }
  } catch (err) {
    log("warn", `Stop: episode self-dump check failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

runHook("stop", main);
