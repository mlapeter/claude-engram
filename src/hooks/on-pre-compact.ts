import { basename } from "node:path";
import type { HookInput } from "../core/types.js";
import { projectHash } from "../core/types.js";
import { createStore } from "../core/store.js";
import { readTranscriptFromCursor } from "../core/transcript.js";
import { log } from "../core/logger.js";
import { recordEvent } from "../core/events.js";

/**
 * PreCompact hook — runs before context compression.
 *
 * Does NOT extract memories. Stop hook handles all extraction on every turn.
 * This hook only advances the cursor so no content is re-processed after compact.
 */
async function main(input: HookInput): Promise<void> {
  const { session_id, transcript_path, cwd } = input;

  log("info", `PreCompact: session=${session_id}`);

  const store = createStore(cwd);

  // Advance cursor to end of transcript (don't extract — Stop already did)
  const cursor = await store.loadCursor();
  const { newCursor } = readTranscriptFromCursor(
    transcript_path,
    cursor,
    session_id,
  );
  await store.saveCursor(newCursor);

  log("info", "PreCompact: cursor advanced");
}

async function readStdin(): Promise<string> {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  return raw;
}

/** Entry: records a hook_pre_compact health event and exits explicitly. */
async function run(): Promise<void> {
  const t0 = Date.now();
  let input: HookInput | null = null;
  try {
    if (process.env.ENGRAM_DISABLE) {
      process.exit(0);
    }
    input = JSON.parse(await readStdin()) as HookInput;
    await main(input);
    recordEvent({ event: "hook_pre_compact", project: basename(input.cwd), project_hash: projectHash(input.cwd), session_id: input.session_id, duration_ms: Date.now() - t0 });
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", `PreCompact failed: ${msg}`);
    if (input) {
      recordEvent({ event: "hook_pre_compact", project: basename(input.cwd), project_hash: projectHash(input.cwd), session_id: input.session_id, duration_ms: Date.now() - t0, error: msg });
    }
    process.exit(0);
  }
}

run();
