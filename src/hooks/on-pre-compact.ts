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
  const { session_id, transcript_path, cwd } = input;

  log("info", `PreCompact: session=${session_id}`);

  const store = createStore(cwd);

  // Step 1: Read any new transcript content before it gets compacted
  const cursor = await store.loadCursor();
  const { content, newCursor } = readTranscriptFromCursor(
    transcript_path,
    cursor,
    session_id,
  );

  // Step 2: Extract memories from content about to be lost
  if (content.length >= MIN_CONTENT_LENGTH) {
    const existingMemories = await store.getRecentAndStrong(session_id);
    const weights = await getWeights(store);
    const weightsHint = getWeightsPromptHint(weights);
    const newMemories = await extractMemories(content, existingMemories, "transcript", weightsHint);

    if (newMemories.length > 0) {
      // Post-extraction dedup
      const dupIndices = await store.checkDuplicates(
        newMemories.map((m) => m.content),
      );
      const isValidUpdate = (u: string | null) => u != null && /^m_\d+_\w+$/.test(u);
      const dedupedMemories = newMemories.filter((m, i) => !dupIndices.has(i) || isValidUpdate(m.updates));

      if (dupIndices.size > 0) {
        log("info", `PreCompact: filtered ${dupIndices.size} duplicate${dupIndices.size > 1 ? "s" : ""} (${dedupedMemories.length} unique)`);
      }

      if (dedupedMemories.length > 0) {
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

        await store.add(fullMemories);
        const weakened = await applyInterference(fullMemories, existingMemories, store);
        log("info", `PreCompact: extracted ${fullMemories.length} memories${weakened > 0 ? `, weakened ${weakened} via interference` : ""}`);
      }
    }
  }

  // Step 3: Update cursor
  await store.saveCursor(newCursor);

  // No JSON output — PreCompact doesn't support hookSpecificOutput.
  // The extraction work above is the value; briefing is injected at SessionStart.
  log("info", "PreCompact: done");
}

main().catch((err) => {
  log("error", `PreCompact failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(0);
});
