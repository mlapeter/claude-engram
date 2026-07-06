import { basename } from "node:path";
import { projectHash } from "../core/types.js";
import type { HookInput } from "../core/types.js";
import { createStore } from "../core/store.js";
import { generateBriefing } from "../core/briefing.js";
import { withTimeout } from "../core/async.js";
import { log } from "../core/logger.js";
import { recordEvent } from "../core/events.js";

/** Watchdog on briefing generation — a slow API call must not hang session close. */
const BRIEFING_TIMEOUT_MS = Number(process.env.ENGRAM_BRIEFING_TIMEOUT_MS) || 90_000;

/**
 * SessionEnd hook — runs when the session ends.
 *
 * Does NOT extract memories. Stop hook handles all extraction on every turn.
 * This hook generates the briefing cache for next session's instant startup
 * and resets the cursor.
 */
async function main(input: HookInput): Promise<void> {
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
}

async function readStdin(): Promise<string> {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  return raw;
}

/** Entry: records a hook_session_end health event and exits explicitly —
 * a timed-out briefing call must not keep the process alive. */
async function run(): Promise<void> {
  const t0 = Date.now();
  let input: HookInput | null = null;
  try {
    if (process.env.ENGRAM_DISABLE) {
      process.exit(0);
    }
    input = JSON.parse(await readStdin()) as HookInput;
    await main(input);
    recordEvent({ event: "hook_session_end", project: basename(input.cwd), project_hash: projectHash(input.cwd), session_id: input.session_id, duration_ms: Date.now() - t0 });
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", `SessionEnd failed: ${msg}`);
    if (input) {
      recordEvent({ event: "hook_session_end", project: basename(input.cwd), project_hash: projectHash(input.cwd), session_id: input.session_id, duration_ms: Date.now() - t0, error: msg });
    }
    process.exit(0);
  }
}

run();
