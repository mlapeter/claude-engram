import { basename } from "node:path";
import { projectHash } from "../core/types.js";
import type { HookInput } from "../core/types.js";
import { createStore } from "../core/store.js";
import { generateBriefing } from "../core/briefing.js";
import { withTimeout, timeoutFromEnv } from "../core/async.js";
import { runHook } from "./harness.js";
import { log } from "../core/logger.js";
import { recordEvent } from "../core/events.js";

/** Watchdog on briefing generation — a slow API call must not hang session
 * close. Must sit safely INSIDE the SessionEnd hook's external timeout (60s
 * in install.sh / settings.json). */
const BRIEFING_TIMEOUT_MS = timeoutFromEnv("ENGRAM_BRIEFING_TIMEOUT_MS", 45_000);

/**
 * SessionEnd hook — runs when the session ends.
 *
 * Does NOT extract memories. Stop hook handles all extraction on every turn.
 * This hook generates the briefing cache for next session's instant startup
 * and resets the cursor.
 */
async function main(input: HookInput): Promise<null> {
  const { session_id, cwd } = input;

  log("info", `SessionEnd: session=${session_id}`);

  const store = createStore(cwd);

  // Generate and cache briefing for next session's instant startup
  try {
    const allMemories = await store.loadAll();
    const projectName = basename(cwd);
    const lastCache = await store.loadBriefingCache();
    const briefing = await withTimeout(
      generateBriefing(allMemories, { cwd, projectName }, lastCache?.generatedAt),
      BRIEFING_TIMEOUT_MS,
      "SessionEnd briefing",
    );
    await store.saveBriefingCache(briefing, allMemories.length);
    log("info", `SessionEnd: cached briefing (${allMemories.length} memories)`);
  } catch (err) {
    log("warn", `SessionEnd: briefing cache failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Reset cursor for next session
  await store.saveCursor({ byteOffset: 0, lastSessionId: "" });
  log("info", `SessionEnd: cursor reset`);
  recordEvent({ event: "session_end", project: basename(cwd), project_hash: projectHash(cwd), session_id });
  return null;
}

runHook("session_end", main);
