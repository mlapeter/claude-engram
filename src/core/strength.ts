import type { Memory } from "./types.js";
import { registerOf } from "./types.js";
import { loadConfig } from "./config.js";

// Re-export defaults for backward compatibility with tests
export const DECAY_RATE = 0.035;
export const RETRIEVAL_BOOST = 0.12;
export const MAX_RETRIEVAL_BONUS = 0.5;
export const CONSOLIDATION_BONUS = 0.2;

export function calculateStrength(memory: Memory): number {
  const config = loadConfig();
  const rawAge = (Date.now() - new Date(memory.created_at).getTime()) / 86_400_000;
  const ageInDays = Number.isFinite(rawAge) && rawAge >= 0 ? rawAge : 0;

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
      decayPenalty = effectiveDecayRate * ageInDays;
      break;
    case "exponential":
      decayPenalty = 1 - Math.exp(-effectiveDecayRate * ageInDays);
      break;
    case "power-law":
    default:
      decayPenalty = effectiveDecayRate * Math.sqrt(ageInDays);
      break;
  }

  return Math.max(
    0,
    Math.min(1, avgSalience + retrievalBonus + consolBonus - decayPenalty),
  );
}
