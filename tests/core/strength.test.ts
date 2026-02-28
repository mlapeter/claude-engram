import { describe, it, expect } from "vitest";
import { calculateStrength, DECAY_RATE, CONSOLIDATION_BONUS, MAX_RETRIEVAL_BONUS } from "../../src/core/strength.js";
import type { Memory } from "../../src/core/types.js";

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "m_test_0001",
    content: "test memory",
    scope: "global",
    salience: { novelty: 0.8, relevance: 0.7, emotional: 0.6, predictive: 0.5 },
    tags: ["identity"],
    access_count: 0,
    last_accessed: null,
    created_at: new Date().toISOString(),
    consolidated: false,
    generalized: false,
    source_session: "test-session",
    updated_from: null,
    ...overrides,
  };
}

describe("calculateStrength", () => {
  it("fresh high-salience memory → strength near avg salience", () => {
    const mem = makeMemory();
    const strength = calculateStrength(mem);
    const expected = (0.8 + 0.7 + 0.6 + 0.5) / 4; // 0.65
    expect(strength).toBeCloseTo(expected, 1);
  });

  it("aged memory with no access → decayed", () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const mem = makeMemory({ created_at: thirtyDaysAgo });
    const strength = calculateStrength(mem);
    const expected = 0.65 - DECAY_RATE * 30;
    expect(strength).toBeCloseTo(expected, 1);
    expect(strength).toBeLessThan(0.65);
  });

  it("memory with high access count → retrieval bonus capped at 0.5", () => {
    const mem = makeMemory({ access_count: 100 });
    const strength = calculateStrength(mem);
    const expected = 0.65 + MAX_RETRIEVAL_BONUS; // capped
    expect(strength).toBeCloseTo(Math.min(1, expected), 1);
  });

  it("consolidated memory → gets 0.2 bonus", () => {
    const mem = makeMemory({ consolidated: true });
    const strength = calculateStrength(mem);
    const unconsolidated = calculateStrength(makeMemory());
    expect(strength - unconsolidated).toBeCloseTo(CONSOLIDATION_BONUS, 2);
  });

  it("NaN/undefined salience fields → treated as 0, no NaN propagation", () => {
    const mem = makeMemory({
      salience: { novelty: NaN, relevance: undefined as any, emotional: 0.5, predictive: NaN },
    });
    const strength = calculateStrength(mem);
    expect(Number.isNaN(strength)).toBe(false);
    expect(strength).toBeCloseTo(0.5 / 4, 1); // only emotional=0.5 counts
  });

  it("strength always clamped 0-1", () => {
    // Very old memory should not go below 0
    const ancient = new Date(Date.now() - 365 * 86_400_000).toISOString();
    const old = makeMemory({
      created_at: ancient,
      salience: { novelty: 0.1, relevance: 0.1, emotional: 0.1, predictive: 0.1 },
    });
    expect(calculateStrength(old)).toBe(0);

    // Super boosted memory should not exceed 1
    const boosted = makeMemory({
      access_count: 100,
      consolidated: true,
      salience: { novelty: 1, relevance: 1, emotional: 1, predictive: 1 },
    });
    expect(calculateStrength(boosted)).toBe(1);
  });
});
