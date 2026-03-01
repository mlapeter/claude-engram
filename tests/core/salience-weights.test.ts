import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore } from "../../src/core/store.js";
import { resetConfig } from "../../src/core/config.js";
import {
  recordSignal,
  computeWeights,
  getWeightsPromptHint,
  type SalienceSignal,
} from "../../src/core/salience-weights.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "engram-weights-test-"));
  process.env.ENGRAM_DATA_DIR = tempDir;
  resetConfig();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.ENGRAM_DATA_DIR;
});

describe("computeWeights", () => {
  it("returns default weights with insufficient signals", () => {
    const signals: SalienceSignal[] = Array.from({ length: 10 }, () => ({
      event: "reinforce" as const,
      salience: { novelty: 0.8, relevance: 0.5, emotional: 0.3, predictive: 0.4 },
      timestamp: new Date().toISOString(),
    }));

    const weights = computeWeights(signals);
    expect(weights).toEqual({ novelty: 1.0, relevance: 1.0, emotional: 1.0, predictive: 1.0 });
  });

  it("boosts dimensions high on reinforced, dampens dimensions high on forgotten", () => {
    const signals: SalienceSignal[] = [];

    // 30 reinforced memories with high emotional
    for (let i = 0; i < 30; i++) {
      signals.push({
        event: "reinforce",
        salience: { novelty: 0.3, relevance: 0.5, emotional: 0.9, predictive: 0.4 },
        timestamp: new Date().toISOString(),
      });
    }

    // 30 pruned memories with high novelty
    for (let i = 0; i < 30; i++) {
      signals.push({
        event: "prune",
        salience: { novelty: 0.9, relevance: 0.5, emotional: 0.2, predictive: 0.4 },
        timestamp: new Date().toISOString(),
      });
    }

    const weights = computeWeights(signals);

    // Emotional should be boosted (high on reinforced, low on pruned)
    expect(weights.emotional).toBeGreaterThan(1.0);
    // Novelty should be dampened (low on reinforced, high on pruned)
    expect(weights.novelty).toBeLessThan(1.0);
  });

  it("clamps weights to 0.5-1.5 range", () => {
    const signals: SalienceSignal[] = [];
    for (let i = 0; i < 60; i++) {
      signals.push({
        event: "reinforce",
        salience: { novelty: 1.0, relevance: 1.0, emotional: 1.0, predictive: 1.0 },
        timestamp: new Date().toISOString(),
      });
    }
    for (let i = 0; i < 60; i++) {
      signals.push({
        event: "forget",
        salience: { novelty: 0.0, relevance: 0.0, emotional: 0.0, predictive: 0.0 },
        timestamp: new Date().toISOString(),
      });
    }

    const weights = computeWeights(signals);
    expect(weights.novelty).toBeLessThanOrEqual(1.5);
    expect(weights.novelty).toBeGreaterThanOrEqual(0.5);
  });
});

describe("getWeightsPromptHint", () => {
  it("returns null for near-default weights", () => {
    const hint = getWeightsPromptHint({ novelty: 1.0, relevance: 1.05, emotional: 0.95, predictive: 1.0 });
    expect(hint).toBeNull();
  });

  it("returns hint string for notable deviations", () => {
    const hint = getWeightsPromptHint({ novelty: 0.7, relevance: 1.0, emotional: 1.3, predictive: 1.0 });
    expect(hint).toContain("de-emphasize novelty");
    expect(hint).toContain("emphasize emotional");
  });
});

describe("recordSignal", () => {
  it("persists signals in meta.salience_signals", async () => {
    const store = createStore("/test");
    await recordSignal(store, "reinforce", { novelty: 0.8, relevance: 0.6, emotional: 0.4, predictive: 0.3 });

    const meta = await store.loadMeta("global") as Record<string, unknown>;
    const signals = meta.salience_signals as SalienceSignal[];
    expect(signals).toHaveLength(1);
    expect(signals[0].event).toBe("reinforce");
  });

  it("caps signals at 200 (ring buffer)", async () => {
    const store = createStore("/test");
    for (let i = 0; i < 210; i++) {
      await recordSignal(store, "prune", { novelty: 0.5, relevance: 0.5, emotional: 0.5, predictive: 0.5 });
    }

    const meta = await store.loadMeta("global") as Record<string, unknown>;
    const signals = meta.salience_signals as SalienceSignal[];
    expect(signals).toHaveLength(200);
  });
});
