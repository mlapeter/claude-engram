/**
 * Proactive interference — new memories actively weaken old conflicting traces.
 *
 * Neuroscience: When a new memory updates an existing one (via updated_from),
 * the old trace's salience dimensions are dampened. This models how the brain
 * resolves interference between competing memory traces in real-time, rather
 * than waiting for sleep consolidation.
 */

import type { Memory } from "./types.js";
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

    const dampedSalience = {
      novelty: old.salience.novelty * factor,
      relevance: old.salience.relevance * factor,
      emotional: old.salience.emotional * factor,
      predictive: old.salience.predictive * factor,
    };

    await store.update(old.id, { salience: dampedSalience });
    weakened++;
    log("info", `Interference: weakened ${old.id} (superseded by ${newMem.id}, factor=${factor})`);
  }

  return weakened;
}
