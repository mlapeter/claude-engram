import type { HookInput } from "../core/types.js";
import { createStore } from "../core/store.js";
import { readTranscriptFromCursor } from "../core/transcript.js";
import { extractMemories } from "../core/salience.js";
import { generateId } from "../core/types.js";
import { applyInterference } from "../core/interference.js";
import { getWeights, getWeightsPromptHint } from "../core/salience-weights.js";
import { log } from "../core/logger.js";

const MIN_CONTENT_LENGTH = 200;

async function main() {
  if (process.env.ENGRAM_DISABLE) {
    return;
  }

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

  // Load bounded dedup window (recent + session + strongest) instead of all memories
  const existingMemories = await store.getRecentAndStrong(session_id);

  // Compute learned salience weights for extraction calibration
  const weights = await getWeights(store);
  const weightsHint = getWeightsPromptHint(weights);

  // Extract new memories
  const newMemories = await extractMemories(content, existingMemories, "transcript", weightsHint);

  if (newMemories.length > 0) {
    const fullMemories = newMemories.map((m) => ({
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
      updated_from: m.updates,
    }));

    await store.add(fullMemories);
    const weakened = await applyInterference(fullMemories, existingMemories, store);
    log("info", `Stop: extracted ${fullMemories.length} memories${weakened > 0 ? `, weakened ${weakened} via interference` : ""}`);
  }

  // Update cursor
  await store.saveCursor(newCursor);
}

main().catch((err) => {
  log("error", `Stop failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(0);
});
