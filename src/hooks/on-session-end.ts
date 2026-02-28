import type { HookInput } from "../core/types.js";
import { createStore } from "../core/store.js";
import { readTranscriptFromCursor } from "../core/transcript.js";
import { extractMemories } from "../core/salience.js";
import { generateId } from "../core/types.js";
import { log } from "../core/logger.js";

async function main() {
  let rawInput = "";
  for await (const chunk of process.stdin) {
    rawInput += chunk;
  }

  const input: HookInput = JSON.parse(rawInput);
  const { session_id, transcript_path, cwd } = input;

  log("info", `SessionEnd: session=${session_id}`);

  const store = createStore(cwd);

  // Read any remaining transcript content after the cursor
  const cursor = await store.loadCursor();
  const { content, newCursor } = readTranscriptFromCursor(
    transcript_path,
    cursor,
    session_id,
  );

  if (content.length > 0) {
    // Load existing memories for contradiction detection
    const existingMemories = await store.loadAll();

    // Extract memories from remaining content (safety net)
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
      log("info", `SessionEnd: extracted ${fullMemories.length} memories (safety net)`);
    }
  }

  // Reset cursor for next session
  await store.saveCursor({ byteOffset: 0, lastSessionId: "" });
  log("info", `SessionEnd: cursor reset`);
}

main().catch((err) => {
  log("error", `SessionEnd failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(0);
});
