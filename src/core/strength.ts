import type { Memory } from "./types.js";
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

  // Power-law decay (Ebbinghaus/Wixted): rate × √age.
  // Rapid initial forgetting that progressively slows (Jost's Law).
  // This matches the brain's most robust finding — unrehearsed memories
  // fade fast, while retrieval and consolidation protect important ones.
  // √30 ≈ 5.48 → decay of 0.192 at 30 days for rate=0.035
  return Math.max(
    0,
    Math.min(1, avgSalience + retrievalBonus + consolBonus - config.decayRate * Math.sqrt(ageInDays)),
  );
}
