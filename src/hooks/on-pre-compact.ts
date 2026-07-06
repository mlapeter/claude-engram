import { basename } from "node:path";
import type { HookInput } from "../core/types.js";
import { projectHash } from "../core/types.js";
import { createStore } from "../core/store.js";
import { readTranscriptFromCursor } from "../core/transcript.js";
import { appendToBuffer, bufferStats } from "../core/buffer.js";
import { runHook, spawnDetached } from "./harness.js";
import { log } from "../core/logger.js";

const MIN_CONTENT_LENGTH = 200;

/**
 * PreCompact hook — context is about to be destroyed, which makes this the
 * one genuinely URGENT encoding moment: capture the un-encoded span and flush
 * the buffer to extraction now, while the experience still exists somewhere.
 */
async function main(input: HookInput): Promise<null> {
  const { session_id, transcript_path, cwd } = input;

  log("info", `PreCompact: session=${session_id}`);

  const store = createStore(cwd);
  const cursor = await store.loadCursor();
  const { content, newCursor } = readTranscriptFromCursor(transcript_path, cursor, session_id);

  if (content.length >= MIN_CONTENT_LENGTH) {
    appendToBuffer(cwd, session_id, content);
  }
  await store.saveCursor(newCursor);

  // Flush whatever has accumulated — after compaction it survives only here
  if (bufferStats(cwd).bytes >= MIN_CONTENT_LENGTH) {
    spawnDetached("run-extraction.ts", [cwd]);
  }

  log("info", "PreCompact: span buffered, extraction spawned");
  return null;
}

runHook("pre_compact", main);
