import type { HookInput } from "../core/types.js";
import { createStore } from "../core/store.js";
import { readTranscriptFromCursor } from "../core/transcript.js";
import { extractMemories } from "../core/salience.js";
import { generateId } from "../core/types.js";
import { log } from "../core/logger.js";

const MIN_CONTENT_LENGTH = 200;

async function main() {
  let rawInput = "";
  for await (const chunk of process.stdin) {
    rawInput += chunk;
  }

  const input: HookInput = JSON.parse(rawInput);

  // Anti-loop: if stop hook is already active, exit immediately
  if (input.stop_hook_active) {
    process.exit(0);
  }

  const { session_id, transcript_path, cwd } = input;

  log("info", `Stop: session=${session_id}`);

  const store = createStore(cwd);

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
    return;
  }

  // Load existing memories for contradiction detection
  const existingMemories = await store.loadAll();

  // Extract new memories
  const newMemories = await extractMemories(content, existingMemories, "transcript");

  if (newMemories.length > 0) {
    const fullMemories = newMemories.map((m) => ({
      id: generateId(),
      content: m.content,
      scope: m.scope,
      salience: m.salience,
      tags: m.tags,
      access_count: 0,
      last_accessed: null,
      created_at: new Date().toISOString(),
      consolidated: false,
      generalized: false,
      source_session: session_id,
      updated_from: m.updates,
    }));

    await store.add(fullMemories);
    log("info", `Stop: extracted ${fullMemories.length} memories`);
  }

  // Update cursor
  await store.saveCursor(newCursor);
}

main().catch((err) => {
  log("error", `Stop failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(0);
});
