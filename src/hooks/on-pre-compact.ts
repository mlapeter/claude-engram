import type { HookInput } from "../core/types.js";
import { createStore } from "../core/store.js";
import { readTranscriptFromCursor } from "../core/transcript.js";
import { extractMemories } from "../core/salience.js";
import { generateId } from "../core/types.js";
import { calculateStrength } from "../core/strength.js";
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
      log("info", `PreCompact: extracted ${fullMemories.length} memories${weakened > 0 ? `, weakened ${weakened} via interference` : ""}`);
    }
  }

  // Step 3: Update cursor
  await store.saveCursor(newCursor);

  // Step 4: Generate mini-briefing for post-compaction context
  const allMemories = await store.loadAll();
  const sorted = allMemories
    .map((m) => ({ memory: m, strength: calculateStrength(m) }))
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 20);

  const briefingLines = sorted.map(({ memory, strength }) =>
    `- [${strength.toFixed(2)}] (${memory.scope}) ${memory.content}`,
  );

  const briefing = `## Pre-compaction memory save

${content.length >= MIN_CONTENT_LENGTH ? "Memories extracted from pre-compaction context." : "No new content to extract."} Key things I remember:

${briefingLines.join("\n")}`;

  // Output JSON for Claude Code to inject post-compaction
  const output = {
    hookSpecificOutput: {
      hookEventName: "PreCompact",
      additionalContext: briefing,
    },
  };

  process.stdout.write(JSON.stringify(output));
  log("info", `PreCompact: briefing injected (${sorted.length} memories, ${briefing.length} chars)`);
}

main().catch((err) => {
  log("error", `PreCompact failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(0);
});
