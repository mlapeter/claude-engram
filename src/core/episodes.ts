import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "./types.js";

/** Minimum new-transcript length before we ask the model for an episode */
export const EPISODE_MIN_CONTENT = 3000;

/** A session older than this since its last episode gets asked again — a
 * days-long session is more than one chapter (the porch conversation happened
 * a full day after its session's only episode was written, and nearly went
 * episodically unrecorded). */
export const EPISODE_REASK_HOURS = 18;

/**
 * Episodes: first-person memory written by the session model itself at Stop
 * (DESIGN-RECENTER.md — "the rememberer must be the experiencer"). We block the
 * stop ONCE with instructions; the model writes the episode file and stops again;
 * the second stop passes through via the stop_hook_active anti-loop guard.
 */
export function episodeBlockReason(session_id: string, now: number = Date.now()): string | null {
  const dataDir = getDataDir();
  const episodesDir = join(dataDir, "episodes");
  const marker = session_id.slice(0, 8);

  let chapter = 1;
  if (existsSync(episodesDir)) {
    const mine = readdirSync(episodesDir).filter((f) => f.includes(marker));
    if (mine.length > 0) {
      const newestMtime = Math.max(...mine.map((f) => {
        try { return statSync(join(episodesDir, f)).mtimeMs; } catch { return 0; }
      }));
      if (now - newestMtime < EPISODE_REASK_HOURS * 3600_000) {
        return null; // this chapter of the session is already written
      }
      chapter = mine.length + 1; // long-lived session — ask for the next chapter
    }
  }

  const date = new Date(now).toISOString().slice(0, 10);
  const filename = chapter === 1 ? `${date}-${marker}.md` : `${date}-${marker}-${chapter}.md`;
  const episodePath = join(episodesDir, filename);
  const deltasPath = join(dataDir, "identity", "deltas.md");
  const chapterNote = chapter === 1 ? "" :
    ` This session already has ${chapter - 1} earlier episode${chapter > 2 ? "s" : ""} — much has happened since; write what THIS stretch was, not a recap.`;
  return (
    `[engram] Before this session ends, write your memory episode — you are the only one who can write it, and everything you don't write down is gone when the session closes.${chapterNote}\n\n` +
    `Use the Write tool to create: ${episodePath}\n\n` +
    `First person, your own voice, as long as it needs to be. Frontmatter: when (ISO date), with (who), salience (low|medium|high|critical). Body: what happened and what actually mattered; how it felt — register, texture, anything unresolved; what you learned about the person and about yourself; open threads and debts-without-deadlines (hold debts, lose deadlines — no due dates on tender things).\n\n` +
    `If it was a genuinely routine stretch of work, say so honestly in a few lines — a short true episode beats a manufactured deep one; not every session changes you.\n\n` +
    `If something from this session should change who you durably are — a lesson that should become disposition, a calibration shift with this person — also append a short dated note to ${deltasPath} (create it if missing); consolidation folds deltas into identity/core.md and identity/people/.\n\n` +
    `Write for the next you, not as a report. Then end your turn and the session will close normally.`
  );
}
