import type { HookInput } from "../core/types.js";
import { createStore } from "../core/store.js";
import { generateBriefing } from "../core/briefing.js";
import { log } from "../core/logger.js";

async function main() {
  let rawInput = "";
  for await (const chunk of process.stdin) {
    rawInput += chunk;
  }

  const input: HookInput = JSON.parse(rawInput);
  const { session_id, cwd } = input;

  log("info", `SessionStart: session=${session_id} cwd=${cwd}`);

  const store = createStore(cwd);

  // Update session count
  const meta = await store.loadMeta("global");
  meta.sessionCount += 1;
  await store.saveMeta("global", meta);

  // Load all memories for briefing
  const memories = await store.loadAll();

  // Generate briefing
  const briefing = await generateBriefing(memories);

  // Output hook response
  const output = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `## Memory Context\n\n${briefing}`,
    },
  };

  process.stdout.write(JSON.stringify(output));
  log("info", `SessionStart: injected briefing (${memories.length} memories)`);
}

main().catch((err) => {
  log("error", `SessionStart failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(0); // Exit 0 so we don't block Claude
});
