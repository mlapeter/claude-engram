import type { Memory } from "./types.js";
import { registerOf } from "./types.js";
import { loadConfig } from "./config.js";
import { ageInDays } from "./active-day.js";

// Re-export defaults for backward compatibility with tests
export const DECAY_RATE = 0.035;
export const RETRIEVAL_BOOST = 0.12;
export const MAX_RETRIEVAL_BONUS = 0.5;
export const CONSOLIDATION_BONUS = 0.2;

export function calculateStrength(memory: Memory): number {
  const config = loadConfig();
  // Active-day age when stamped (days lived, not calendar); calendar fallback
  const age = ageInDays(memory);

  // Sanitize salience — prevents NaN propagation
  const n = Number(memory.salience?.novelty) || 0;
  const r = Number(memory.salience?.relevance) || 0;
  const e = Number(memory.salience?.emotional) || 0;
  const p = Number(memory.salience?.predictive) || 0;
  const avgSalience = (n + r + e + p) / 4;

  const retrievalBonus = Math.min(
    memory.access_count * config.retrievalBoost,
    config.maxRetrievalBonus,
  );
  const consolBonus = memory.consolidated ? config.consolidationBonus : 0;

  // Decay model — power-law (Ebbinghaus/Wixted) is the preferred embodiment,
  // matching empirical findings: rapid initial forgetting that progressively
  // slows (Jost's Law). Linear and exponential variants are supported.
  // Archived memories use a substantially lower decay rate, modeling the
  // distinction between retrieval failure (trace exists) and true forgetting.
  // √30 ≈ 5.48 → decay of 0.192 at 30 days for power-law with rate=0.035
  //
  // Register physics: craft knowledge decays faster (it's mostly re-derivable
  // from repos and docs); person/self memories decay slower — forgetting is a
  // feature, but it isn't register-blind.
  const isArchived = memory.archived === true;
  const registerMultiplier = isArchived ? 1 : {
    craft: config.decayMultiplierCraft,
    person: config.decayMultiplierPerson,
    self: config.decayMultiplierSelf,
  }[registerOf(memory)];
  const effectiveDecayRate = (isArchived ? config.archiveDecayRate : config.decayRate) * registerMultiplier;

  let decayPenalty: number;
  switch (config.decayModel) {
    case "linear":
      decayPenalty = effectiveDecayRate * age;
      break;
    case "exponential":
      decayPenalty = 1 - Math.exp(-effectiveDecayRate * age);
      break;
    case "power-law":
    default:
      decayPenalty = effectiveDecayRate * Math.sqrt(age);
      break;
  }

  return Math.max(
    0,
    Math.min(1, avgSalience + retrievalBonus + consolBonus - decayPenalty),
  );
}
