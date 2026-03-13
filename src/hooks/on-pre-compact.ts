import type { HookInput } from "../core/types.js";
import { createStore } from "../core/store.js";
import { readTranscriptFromCursor } from "../core/transcript.js";
import { log } from "../core/logger.js";

/**
 * PreCompact hook — runs before context compression.
 *
 * Does NOT extract memories. Stop hook handles all extraction on every turn.
 * This hook only advances the cursor so no content is re-processed after compact.
 */
async function main() {
  if (process.env.ENGRAM_DISABLE) {
    return;
  }

  let rawInput = "";
  for await (const chunk of process.stdin) {
    rawInput += chunk;
  }

  const input: HookInput = JSON.parse(rawInput);
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

main().catch((err) => {
  log("error", `PreCompact failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(0);
});
