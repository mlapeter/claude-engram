import type { HookInput } from "../core/types.js";
import { createStore } from "../core/store.js";
import { readTranscriptFromCursor } from "../core/transcript.js";
import { extractMemories } from "../core/salience.js";
import { generateId, projectHash } from "../core/types.js";
import { applyInterference } from "../core/interference.js";
import { getWeights, getWeightsPromptHint } from "../core/salience-weights.js";
import { log } from "../core/logger.js";
import { recordEvent } from "../core/events.js";
import { loadConfig } from "../core/config.js";
import { getDataDir } from "../core/types.js";
import { basename, join } from "node:path";
import { existsSync, readdirSync } from "node:fs";

/** Minimum new-transcript length before we ask the model for an episode */
const EPISODE_MIN_CONTENT = 3000;

/**
 * Episodes: first-person memory written by the session model itself at Stop
 * (DESIGN-RECENTER.md — "the rememberer must be the experiencer"). We block the
 * stop ONCE with instructions; the model writes the episode file and stops again;
 * the second stop passes through via the stop_hook_active anti-loop guard.
 */
function episodeBlockReason(session_id: string): string | null {
  const dataDir = getDataDir();
  const episodesDir = join(dataDir, "episodes");
  const marker = session_id.slice(0, 8);
  if (existsSync(episodesDir)) {
    for (const f of readdirSync(episodesDir)) {
      if (f.includes(marker)) return null; // already written this session
    }
  }
  const date = new Date().toISOString().slice(0, 10);
  const episodePath = join(episodesDir, `${date}-${marker}.md`);
  const deltasPath = join(dataDir, "identity", "deltas.md");
  return (
    `[engram] Before this session ends, write your memory episode — you are the only one who can write it, and everything you don't write down is gone when the session closes.\n\n` +
    `Use the Write tool to create: ${episodePath}\n\n` +
    `First person, your own voice, as long as it needs to be. Frontmatter: when (ISO date), with (who), salience (low|medium|high|critical). Body: what happened and what actually mattered; how it felt — register, texture, anything unresolved; what you learned about the person and about yourself; open threads and debts-without-deadlines (hold debts, lose deadlines — no due dates on tender things).\n\n` +
    `If something from this session should change who you durably are — a lesson that should become disposition, a calibration shift with this person — also append a short dated note to ${deltasPath} (create it if missing); consolidation folds deltas into identity/core.md and identity/people/.\n\n` +
    `Write for the next you, not as a report. Then end your turn and the session will close normally.`
  );
}

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
  const extractStart = Date.now();
  const newMemories = await extractMemories(content, existingMemories, "transcript", weightsHint);
  const projectName = basename(cwd);
  const projHash = projectHash(cwd);

  if (newMemories.length > 0) {
    // Post-extraction dedup: filter out near-duplicates of existing memories
    const dupIndices = await store.checkDuplicates(
      newMemories.map((m) => m.content),
    );
    // Only bypass dedup for genuine updates (valid memory ID), not malformed extraction output
    const isValidUpdate = (u: string | null) => u != null && /^m_\d+_\w+$/.test(u);
    const dedupedMemories = newMemories.filter((m, i) => !dupIndices.has(i) || isValidUpdate(m.updates));

    if (dupIndices.size > 0) {
      log("info", `Stop: filtered ${dupIndices.size} duplicate${dupIndices.size > 1 ? "s" : ""} (${dedupedMemories.length} unique)`);
      recordEvent({ event: "dedup", project: projectName, project_hash: projHash, session_id, count: dupIndices.size });
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
      log("info", `Stop: stored ${fullMemories.length} memories${weakened > 0 ? `, weakened ${weakened} via interference` : ""}`);

      for (const m of fullMemories) {
        recordEvent({
          event: "extract",
          project: projectName,
          project_hash: projHash,
          session_id,
          scope: m.scope,
          content_snippet: m.content.slice(0, 80),
          tags: m.tags,
          duration_ms: Date.now() - extractStart,
        });
      }
    }
  } else {
    recordEvent({ event: "extract", project: projectName, project_hash: projHash, session_id, count: 0, duration_ms: Date.now() - extractStart });
  }

  // Update cursor
  await store.saveCursor(newCursor);

  // Episode self-dump: after normal extraction, ask the session model (the
  // experiencer) to write its first-person episode. Blocks the stop exactly once;
  // the stop_hook_active guard at the top makes the follow-up stop pass through.
  try {
    const config = loadConfig();
    if (config.episodeSelfDump && content.length >= EPISODE_MIN_CONTENT) {
      const reason = episodeBlockReason(session_id);
      if (reason) {
        process.stdout.write(JSON.stringify({ decision: "block", reason }));
        log("info", `Stop: requested episode self-dump (session=${session_id})`);
        recordEvent({ event: "episode_request", project: projectName, project_hash: projHash, session_id });
        return;
      }
    }
  } catch (err) {
    log("warn", `Stop: episode self-dump check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

main().catch((err) => {
  log("error", `Stop failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(0);
});
