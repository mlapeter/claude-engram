import type { Memory } from "./types.js";

export const DECAY_RATE = 0.015;
export const RETRIEVAL_BOOST = 0.12;
export const MAX_RETRIEVAL_BONUS = 0.5;
export const CONSOLIDATION_BONUS = 0.2;

export function calculateStrength(memory: Memory): number {
  const ageInDays =
    (Date.now() - new Date(memory.created_at).getTime()) / 86_400_000;

  // Sanitize salience — prevents NaN propagation
  const n = Number(memory.salience?.novelty) || 0;
  const r = Number(memory.salience?.relevance) || 0;
  const e = Number(memory.salience?.emotional) || 0;
  const p = Number(memory.salience?.predictive) || 0;
  const avgSalience = (n + r + e + p) / 4;

  const retrievalBonus = Math.min(
    memory.access_count * RETRIEVAL_BOOST,
    MAX_RETRIEVAL_BONUS,
  );
  const consolBonus = memory.consolidated ? CONSOLIDATION_BONUS : 0;

  return Math.max(
    0,
    Math.min(1, avgSalience + retrievalBonus + consolBonus - DECAY_RATE * ageInDays),
  );
}
