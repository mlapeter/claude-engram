/**
 * Proactive interference — new memories actively weaken old conflicting traces.
 *
 * Neuroscience: When a new memory updates an existing one (via updated_from),
 * the old trace's salience dimensions are dampened. This models how the brain
 * resolves interference between competing memory traces in real-time, rather
 * than waiting for sleep consolidation.
 */

import type { Memory } from "./types.js";
import { registerOf } from "./types.js";
import { loadConfig } from "./config.js";
import { log } from "./logger.js";
import type { MemoryStore } from "./store.js";

/**
 * For each new memory with a non-null `updated_from`, multiply the old
 * memory's salience dimensions by the interference factor (default 0.7).
 * Returns the count of memories weakened.
 */
export async function applyInterference(
  newMemories: Memory[],
  existingMemories: Memory[],
  store: MemoryStore,
): Promise<number> {
  const config = loadConfig();
  const factor = config.interferenceFactor;
  const existingById = new Map(existingMemories.map((m) => [m.id, m]));
  let weakened = 0;

  for (const newMem of newMemories) {
    if (!newMem.updated_from) continue;

    const old = existingById.get(newMem.updated_from);
    if (!old) continue;
    if (old.protected) continue; // sacred-verbatim memories don't get weakened
    // Registers never mix: a craft memory claiming to "update" a person/self
    // memory must not weaken it — that's mislabeling, not supersession
    if (registerOf(newMem) !== registerOf(old)) continue;

    // Floor of 0.1 prevents salience from spiraling to zero via compounding (0.7^n)
    const SALIENCE_FLOOR = 0.1;
    const dampen = (v: number) => Math.max(SALIENCE_FLOOR, v * factor);
    const dampedSalience = {
      novelty: dampen(old.salience.novelty),
      relevance: dampen(old.salience.relevance),
      emotional: dampen(old.salience.emotional),
      predictive: dampen(old.salience.predictive),
    };

    await store.update(old.id, { salience: dampedSalience });
    weakened++;
    log("info", `Interference: weakened ${old.id} (superseded by ${newMem.id}, factor=${factor})`);
  }

  return weakened;
}
