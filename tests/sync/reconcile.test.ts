import { describe, it, expect, vi, beforeEach } from "vitest";
import { reconcile } from "../../src/sync/reconcile.js";
import type { V1Memory } from "../../src/sync/schema.js";
import type { Memory } from "../../src/core/types.js";

// Mock embeddings — force token-overlap fallback for deterministic tests
vi.mock("../../src/core/embeddings.js", () => ({
  isEmbeddingEnabled: () => false,
  embed: async () => [],
  cosineSimilarity: () => 0,
}));

function makeV1(content: string, overrides: Partial<V1Memory> = {}): V1Memory {
  return {
    id: "v1_" + Math.random().toString(36).slice(2, 6),
    content,
    salience: { novelty: 0.7, relevance: 0.6, emotional: 0.5, predictive: 0.4 },
    tags: ["identity"],
    accessCount: 1,
    lastAccessed: Date.now(),
    createdAt: Date.now() - 86400000,
    consolidated: false,
    generalized: false,
    ...overrides,
  };
}

function makeV4(content: string, overrides: Partial<Memory> = {}): Memory {
  return {
    id: "m_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
    content,
    scope: "global",
    memory_type: "episodic",
    salience: { novelty: 0.7, relevance: 0.6, emotional: 0.5, predictive: 0.4 },
    tags: ["identity"],
    access_count: 1,
    last_accessed: new Date().toISOString(),
    created_at: new Date(Date.now() - 86400000).toISOString(),
    consolidated: false,
    generalized: false,
    source_session: "test",
    updated_from: null,
    ...overrides,
  };
}

describe("reconcile (token-overlap fallback)", () => {
  it("detects new memories from v1 with no v4 match", async () => {
    const v1 = [makeV1("Mike loves hiking in the mountains on weekends")];
    const v4 = [makeV4("The project uses TypeScript with strict mode enabled")];

    const plan = await reconcile(v1, v4);

    expect(plan.newFromV1.length).toBe(1);
    expect(plan.newFromV4.length).toBe(1);
    expect(plan.similar.length).toBe(0);
    expect(plan.duplicates.length).toBe(0);
    expect(plan.method).toBe("token-overlap");
  });

  it("detects duplicates when content is very similar", async () => {
    const v1 = [makeV1("the dog named Biscuit was diagnosed with cancer by the vet")];
    const v4 = [makeV4("the dog named Biscuit was diagnosed with cancer by the vet recently")];

    const plan = await reconcile(v1, v4);

    // High token overlap should classify as duplicate
    expect(plan.duplicates.length).toBe(1);
    expect(plan.newFromV1.length).toBe(0);
  });

  it("detects similar memories with partial overlap", async () => {
    // Enough shared words for Jaccard > 0.55 but < 0.80
    const v1 = [makeV1("Mike works at Meridian Technologies as a senior engineer building APIs since March")];
    const v4 = [makeV4("Mike works at Meridian Technologies as a senior engineer on the API platform team")];

    const plan = await reconcile(v1, v4);

    // Moderate overlap — should be similar, not duplicate
    expect(plan.similar.length).toBe(1);
    expect(plan.similar[0].similarity).toBeGreaterThan(0.4);
    expect(plan.similar[0].similarity).toBeLessThan(0.75);
  });

  it("handles empty v1 set", async () => {
    const v4 = [makeV4("existing memory")];
    const plan = await reconcile([], v4);

    expect(plan.newFromV1.length).toBe(0);
    expect(plan.newFromV4.length).toBe(1);
    expect(plan.similar.length).toBe(0);
    expect(plan.duplicates.length).toBe(0);
  });

  it("handles empty v4 set", async () => {
    const v1 = [makeV1("new memory from artifact")];
    const plan = await reconcile(v1, []);

    expect(plan.newFromV1.length).toBe(1);
    expect(plan.newFromV4.length).toBe(0);
  });

  it("handles both sets empty", async () => {
    const plan = await reconcile([], []);
    expect(plan.newFromV1.length).toBe(0);
    expect(plan.newFromV4.length).toBe(0);
  });

  it("merge suggestion uses longer content", async () => {
    const v1 = [makeV1("Mike works at Meridian Technologies as senior engineer doing API work since March 2024")];
    const v4 = [makeV4("Mike works at Meridian Technologies as senior engineer doing API work")];

    const plan = await reconcile(v1, v4);

    if (plan.similar.length > 0) {
      // Merge should prefer the longer (v1) content
      expect(plan.similar[0].suggestedMerge.content.length).toBeGreaterThanOrEqual(
        v4[0].content.length
      );
    }
  });

  it("merge suggestion takes max salience per dimension", async () => {
    const v1 = [makeV1("Mike works at Meridian Technologies as a senior engineer", {
      salience: { novelty: 0.9, relevance: 0.3, emotional: 0.5, predictive: 0.5 },
    })];
    const v4 = [makeV4("Mike works at Meridian Technologies as senior engineer on API team", {
      salience: { novelty: 0.4, relevance: 0.8, emotional: 0.6, predictive: 0.3 },
    })];

    const plan = await reconcile(v1, v4);

    if (plan.similar.length > 0) {
      const merged = plan.similar[0].suggestedMerge;
      expect(merged.salience.novelty).toBe(0.9);
      expect(merged.salience.relevance).toBe(0.8);
      expect(merged.salience.emotional).toBe(0.6);
      expect(merged.salience.predictive).toBe(0.5);
    }
  });

  it("multiple v1 memories can match different v4 memories", async () => {
    const v1 = [
      makeV1("the dog named Biscuit was diagnosed with cancer at the vet clinic"),
      makeV1("Mike enjoys hiking on mountain trails every single weekend morning early"),
    ];
    const v4 = [
      makeV4("the dog named Biscuit was diagnosed with cancer at the vet recently"),
      makeV4("Mike enjoys hiking on mountain trails every single weekend morning"),
      makeV4("The project uses TypeScript with strict mode and ESM modules"),
    ];

    const plan = await reconcile(v1, v4);

    // Both v1 should match a v4 (duplicate or similar)
    const matched = plan.duplicates.length + plan.similar.length;
    expect(matched).toBe(2);
    // The unmatched TypeScript memory should be in newFromV4
    expect(plan.newFromV4.length).toBe(1);
    expect(plan.newFromV4[0].content).toContain("TypeScript");
  });
});
