import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "./types.js";

/** Minimum new-transcript length before we ask the model for an episode */
export const EPISODE_MIN_CONTENT = 3000;

/**
 * Episodes: first-person memory written by the session model itself at Stop
 * (DESIGN-RECENTER.md — "the rememberer must be the experiencer"). We block the
 * stop ONCE with instructions; the model writes the episode file and stops again;
 * the second stop passes through via the stop_hook_active anti-loop guard.
 */
export function episodeBlockReason(session_id: string): string | null {
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
