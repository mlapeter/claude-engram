import { basename } from "node:path";
import type { HookInput } from "../core/types.js";
import { createStore } from "../core/store.js";
import { generateBriefing } from "../core/briefing.js";
import { log } from "../core/logger.js";

/**
 * SessionEnd hook — runs when the session ends.
 *
 * Does NOT extract memories. Stop hook handles all extraction on every turn.
 * This hook generates the briefing cache for next session's instant startup
 * and resets the cursor.
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
  const { session_id, cwd } = input;

  log("info", `SessionEnd: session=${session_id}`);

  const store = createStore(cwd);

  // Generate and cache briefing for next session's instant startup
  try {
    const allMemories = await store.loadAll();
    const projectName = basename(cwd);
    const lastCache = await store.loadBriefingCache();
    const briefing = await generateBriefing(
      allMemories,
      { cwd, projectName },
      lastCache?.generatedAt,
    );
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
