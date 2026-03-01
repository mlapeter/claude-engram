/**
 * Learned salience — VTA dopamine-style adaptation.
 *
 * Neuroscience: The ventral tegmental area (VTA) learns what to attend to
 * through reward signals. Reinforced memories emit positive signals;
 * forgotten/pruned memories emit negative signals. Over time, the extraction
 * system learns which salience dimensions matter most for this user.
 */

import type { Salience, Meta } from "./types.js";
import { log } from "./logger.js";
import type { MemoryStore } from "./store.js";

export interface SalienceSignal {
  event: "reinforce" | "forget" | "prune";
  salience: Salience;
  timestamp: string;
}

export interface SalienceWeights {
  novelty: number;
  relevance: number;
  emotional: number;
  predictive: number;
}

const DEFAULT_WEIGHTS: SalienceWeights = { novelty: 1.0, relevance: 1.0, emotional: 1.0, predictive: 1.0 };
const MAX_SIGNALS = 200;
const MIN_SIGNALS_FOR_LEARNING = 50;
const WEIGHT_MIN = 0.5;
const WEIGHT_MAX = 1.5;

function clampWeight(w: number): number {
  return Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, w));
}

/**
 * Record a salience signal from a reinforcement, forget, or prune event.
 * Appends to meta.salience_signals (ring buffer, last 200).
 */
export async function recordSignal(
  store: MemoryStore,
  event: SalienceSignal["event"],
  salience: Salience,
): Promise<void> {
  const meta = await store.loadMeta("global") as Meta & { salience_signals?: SalienceSignal[]; salience_weights_cache?: SalienceWeights };
  const signals = meta.salience_signals ?? [];

  signals.push({ event, salience, timestamp: new Date().toISOString() });

  // Ring buffer: keep last MAX_SIGNALS
  if (signals.length > MAX_SIGNALS) {
    signals.splice(0, signals.length - MAX_SIGNALS);
  }

  await store.saveMeta("global", {
    ...meta,
    salience_signals: signals,
    // Invalidate cache when new signal arrives
    salience_weights_cache: undefined,
  } as Meta);

  log("info", `Salience signal: ${event} (n=${signals.length})`);
}

/**
 * Compute per-dimension weights from accumulated signals.
 * Returns defaults until MIN_SIGNALS_FOR_LEARNING signals have been accumulated.
 *
 * Logic: dimensions high on reinforced memories get boosted (positive reward);
 * dimensions high on forgotten/pruned memories get dampened (negative reward).
 */
export function computeWeights(signals: SalienceSignal[]): SalienceWeights {
  if (signals.length < MIN_SIGNALS_FOR_LEARNING) {
    return { ...DEFAULT_WEIGHTS };
  }

  const dims: (keyof Salience)[] = ["novelty", "relevance", "emotional", "predictive"];
  const weights: SalienceWeights = { ...DEFAULT_WEIGHTS };

  for (const dim of dims) {
    let positiveSum = 0;
    let positiveCount = 0;
    let negativeSum = 0;
    let negativeCount = 0;

    for (const s of signals) {
      const val = s.salience[dim] ?? 0;
      if (s.event === "reinforce") {
        positiveSum += val;
        positiveCount++;
      } else {
        negativeSum += val;
        negativeCount++;
      }
    }

    const posAvg = positiveCount > 0 ? positiveSum / positiveCount : 0.5;
    const negAvg = negativeCount > 0 ? negativeSum / negativeCount : 0.5;

    // Dimension gets boosted if it's high on reinforced and low on forgotten
    // Delta ranges roughly -1 to +1; map to 0.5-1.5 weight range
    const delta = posAvg - negAvg;
    weights[dim] = clampWeight(1.0 + delta * 0.5);
  }

  return weights;
}

/**
 * Get weights, using meta cache if available.
 */
export async function getWeights(store: MemoryStore): Promise<SalienceWeights> {
  const meta = await store.loadMeta("global") as Meta & { salience_signals?: SalienceSignal[]; salience_weights_cache?: SalienceWeights };

  if (meta.salience_weights_cache) {
    return meta.salience_weights_cache;
  }

  const signals = meta.salience_signals ?? [];
  const weights = computeWeights(signals);

  // Cache the weights
  await store.saveMeta("global", {
    ...meta,
    salience_weights_cache: { ...weights } as Record<string, number>,
  });

  return weights;
}

/**
 * Generate a hint string for the extraction prompt based on learned weights.
 * Returns null if weights are near default (no meaningful learning yet).
 */
export function getWeightsPromptHint(weights: SalienceWeights): string | null {
  const dims: Array<{ name: string; key: keyof SalienceWeights }> = [
    { name: "novelty", key: "novelty" },
    { name: "relevance", key: "relevance" },
    { name: "emotional", key: "emotional" },
    { name: "predictive", key: "predictive" },
  ];

  const notable = dims.filter((d) => Math.abs(weights[d.key] - 1.0) > 0.1);
  if (notable.length === 0) return null;

  const parts = notable.map((d) => {
    const w = weights[d.key];
    const direction = w > 1.0 ? "emphasize" : "de-emphasize";
    return `${direction} ${d.name} (${w.toFixed(1)})`;
  });

  return parts.join(", ");
}
