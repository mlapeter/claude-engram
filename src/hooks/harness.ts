import { basename } from "node:path";
import type { HookInput } from "../core/types.js";
import { projectHash } from "../core/types.js";
import { log } from "../core/logger.js";
import { recordEvent } from "../core/events.js";

/**
 * Shared hook entrypoint harness. Owns the contract every hook must honor:
 * - ENGRAM_DISABLE short-circuits before any work
 * - stdin is parsed once; parse failures are logged, never thrown to the shell
 * - a hook_<name> health event records duration_ms and error for every run
 * - the process exits EXPLICITLY — a timed-out or abandoned network promise
 *   must never keep the hook (and the session event) alive
 * - stdout payload, when present, is flushed via write-callback before exit
 *
 * main() returns the string to emit on stdout, or null for a silent pass.
 */
export function runHook(
  name: string,
  main: (input: HookInput) => Promise<string | null>,
): void {
  const t0 = Date.now();
  void (async () => {
    let input: HookInput | null = null;
    try {
      if (process.env.ENGRAM_DISABLE) {
        process.exit(0);
      }
      input = JSON.parse(await readStdin()) as HookInput;
      const output = await main(input);
      recordEvent({
        event: `hook_${name}`,
        project: basename(input.cwd),
        project_hash: projectHash(input.cwd),
        session_id: input.session_id,
        duration_ms: Date.now() - t0,
      });
      if (output) {
        process.stdout.write(output, () => process.exit(0));
      } else {
        process.exit(0);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("error", `${name} hook failed: ${msg}`);
      if (input) {
        recordEvent({
          event: `hook_${name}`,
          project: basename(input.cwd),
          project_hash: projectHash(input.cwd),
          session_id: input.session_id,
          duration_ms: Date.now() - t0,
          error: msg,
        });
      }
      process.exit(0); // exit 0 so we never block Claude
    }
  })();
}

async function readStdin(): Promise<string> {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  return raw;
}
