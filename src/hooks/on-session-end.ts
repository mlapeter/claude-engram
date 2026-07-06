import { basename } from "node:path";
import { projectHash } from "../core/types.js";
import type { HookInput } from "../core/types.js";
import { createStore } from "../core/store.js";
import { readTranscriptFromCursor } from "../core/transcript.js";
import { appendToBuffer, bufferStats } from "../core/buffer.js";
import { runHook, spawnDetached } from "./harness.js";
import { log } from "../core/logger.js";
import { recordEvent } from "../core/events.js";

const MIN_CONTENT_LENGTH = 200;

/**
 * SessionEnd hook — capture the final span, then hand the slow work to the
 * detached runner: extract the buffer, THEN regenerate the briefing cache so
 * tomorrow's wake-up includes today's final memories. The hook itself stays
 * milliseconds; the runner has no deadline.
 */
async function main(input: HookInput): Promise<null> {
  const { session_id, transcript_path, cwd } = input;

  log("info", `SessionEnd: session=${session_id}`);

  const store = createStore(cwd);
  const cursor = await store.loadCursor();
  const { content } = readTranscriptFromCursor(transcript_path, cursor, session_id);
  if (content.length >= MIN_CONTENT_LENGTH) {
    appendToBuffer(cwd, session_id, content);
  }

  // Extract whatever's buffered, then refresh the briefing — the runner
  // no-ops the extraction half gracefully if the buffer holds only scraps
  spawnDetached("run-extraction.ts", [cwd, "--then-briefing"]);

  // Reset cursor for next session
  await store.saveCursor({ byteOffset: 0, lastSessionId: "" });
  log("info", `SessionEnd: cursor reset, extraction+briefing spawned`);
  recordEvent({ event: "session_end", project: basename(cwd), project_hash: projectHash(cwd), session_id });
  return null;
}

runHook("session_end", main);
