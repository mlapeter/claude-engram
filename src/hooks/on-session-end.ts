import { basename } from "node:path";
import type { HookInput } from "../core/types.js";
import { createStore } from "../core/store.js";
import { readTranscriptFromCursor } from "../core/transcript.js";
import { extractMemories } from "../core/salience.js";
import { generateBriefing } from "../core/briefing.js";
import { generateId } from "../core/types.js";
import { applyInterference } from "../core/interference.js";
import { getWeights, getWeightsPromptHint } from "../core/salience-weights.js";
import { log } from "../core/logger.js";

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
    // Load bounded dedup window (recent + session + strongest) instead of all memories
    const existingMemories = await store.getRecentAndStrong(session_id);

    // Compute learned salience weights for extraction calibration
    const weights = await getWeights(store);
    const weightsHint = getWeightsPromptHint(weights);

    // Extract memories from remaining content (safety net)
    const newMemories = await extractMemories(content, existingMemories, "transcript", weightsHint);

    if (newMemories.length > 0) {
      // Post-extraction dedup
      const dupIndices = await store.checkDuplicates(
        newMemories.map((m) => m.content),
      );
      const isValidUpdate = (u: string | null) => u != null && /^m_\d+_\w+$/.test(u);
      const dedupedMemories = newMemories.filter((m, i) => !dupIndices.has(i) || isValidUpdate(m.updates));

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
        log("info", `SessionEnd: stored ${fullMemories.length} memories${weakened > 0 ? `, weakened ${weakened} via interference` : ""}`);
      }
    }
  }

  // Generate and cache briefing for next session's instant startup
  try {
    const allMemories = await store.loadAll();
    const projectName = basename(cwd);
    const briefing = await generateBriefing(allMemories, { cwd, projectName });
    await store.saveBriefingCache(briefing, allMemories.length);
    log("info", `SessionEnd: cached briefing (${allMemories.length} memories)`);
  } catch (err) {
    log("warn", `SessionEnd: briefing cache failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Reset cursor for next session
  await store.saveCursor({ byteOffset: 0, lastSessionId: "" });
  log("info", `SessionEnd: cursor reset`);
}

main().catch((err) => {
  log("error", `SessionEnd failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(0);
});
