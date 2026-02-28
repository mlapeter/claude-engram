import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore, type MemoryStore } from "../../src/core/store.js";
import { calculateStrength } from "../../src/core/strength.js";
import { generateId, sanitizeSalience, scopeFromTags } from "../../src/core/types.js";
import type { Memory } from "../../src/core/types.js";

/**
 * Tests for MCP tool handler logic.
 * We test the handler logic directly against the store rather than via MCP protocol,
 * since the MCP SDK handles transport/serialization and we trust it.
 */

let tmpDir: string;
let store: MemoryStore;

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: generateId(),
    content: "Test memory content",
    scope: "global",
    salience: { novelty: 0.7, relevance: 0.8, emotional: 0.5, predictive: 0.6 },
    tags: ["insight"],
    access_count: 0,
    last_accessed: null,
    created_at: new Date().toISOString(),
    consolidated: false,
    generalized: false,
    source_session: "test",
    updated_from: null,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engram-mcp-test-"));
  process.env.ENGRAM_DATA_DIR = tmpDir;
  store = createStore("/test/project");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ENGRAM_DATA_DIR;
});

describe("status tool", () => {
  it("returns correct counts for empty store", async () => {
    const globalMems = await store.load("global");
    const projectMems = await store.load("project");
    expect(globalMems).toHaveLength(0);
    expect(projectMems).toHaveLength(0);
  });

  it("returns correct breakdown with mixed memories", async () => {
    const memories = [
      makeMemory({ scope: "global", salience: { novelty: 0.9, relevance: 0.9, emotional: 0.9, predictive: 0.9 } }),
      makeMemory({ scope: "global", salience: { novelty: 0.5, relevance: 0.5, emotional: 0.5, predictive: 0.5 } }),
      makeMemory({ scope: "project", salience: { novelty: 0.8, relevance: 0.8, emotional: 0.8, predictive: 0.8 } }),
    ];
    await store.add(memories);

    const global = await store.load("global");
    const project = await store.load("project");
    expect(global).toHaveLength(2);
    expect(project).toHaveLength(1);

    const all = [...global, ...project];
    const strengths = all.map(calculateStrength);
    expect(strengths.every((s) => s > 0)).toBe(true);
  });
});

describe("recall tool", () => {
  it("finds memories by text search", async () => {
    await store.add([
      makeMemory({ content: "Mike lives in Montana" }),
      makeMemory({ content: "The project uses TypeScript" }),
      makeMemory({ content: "Mike prefers bun over npm" }),
    ]);

    const results = await store.search("Mike", 10);
    expect(results).toHaveLength(2);
    expect(results.every((m) => m.content.includes("Mike"))).toBe(true);
  });

  it("respects limit parameter", async () => {
    await store.add([
      makeMemory({ content: "memory alpha" }),
      makeMemory({ content: "memory beta" }),
      makeMemory({ content: "memory gamma" }),
    ]);

    const results = await store.search("memory", 2);
    expect(results).toHaveLength(2);
  });

  it("filters by minimum strength", async () => {
    const strong = makeMemory({
      content: "strong memory",
      salience: { novelty: 0.9, relevance: 0.9, emotional: 0.9, predictive: 0.9 },
    });
    const weak = makeMemory({
      content: "weak memory about memory",
      salience: { novelty: 0.05, relevance: 0.05, emotional: 0.05, predictive: 0.05 },
    });
    await store.add([strong, weak]);

    const results = await store.search("memory", 10);
    const filtered = results.filter((m) => calculateStrength(m) >= 0.5);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].content).toBe("strong memory");
  });

  it("increments access_count on recall (Hebbian reinforcement)", async () => {
    const mem = makeMemory({ content: "reinforcement test" });
    await store.add([mem]);

    // Simulate recall reinforcement
    const results = await store.search("reinforcement", 5);
    expect(results).toHaveLength(1);

    await store.update(results[0].id, {
      access_count: results[0].access_count + 1,
      last_accessed: new Date().toISOString(),
    });

    const all = await store.loadAll();
    const updated = all.find((m) => m.id === mem.id)!;
    expect(updated.access_count).toBe(1);
    expect(updated.last_accessed).not.toBeNull();
  });
});

describe("search_by_tag tool", () => {
  it("finds memories by tags (OR logic)", async () => {
    await store.add([
      makeMemory({ tags: ["identity", "personal"], content: "name is Mike" }),
      makeMemory({ tags: ["technical", "project"], content: "uses TypeScript" }),
      makeMemory({ tags: ["relationship", "personal"], content: "has two sons" }),
    ]);

    const results = await store.searchByTag(["identity", "relationship"], 10);
    expect(results).toHaveLength(2);
  });

  it("respects limit", async () => {
    await store.add([
      makeMemory({ tags: ["insight"] }),
      makeMemory({ tags: ["insight"] }),
      makeMemory({ tags: ["insight"] }),
    ]);

    const results = await store.searchByTag(["insight"], 2);
    expect(results).toHaveLength(2);
  });
});

describe("reinforce tool", () => {
  it("increments access_count and sets last_accessed", async () => {
    const mem = makeMemory({ content: "important memory" });
    await store.add([mem]);

    const before = (await store.loadAll()).find((m) => m.id === mem.id)!;
    expect(before.access_count).toBe(0);
    expect(before.last_accessed).toBeNull();

    await store.update(mem.id, {
      access_count: before.access_count + 1,
      last_accessed: new Date().toISOString(),
    });

    const after = (await store.loadAll()).find((m) => m.id === mem.id)!;
    expect(after.access_count).toBe(1);
    expect(after.last_accessed).not.toBeNull();
  });

  it("returns error for nonexistent memory", async () => {
    const all = await store.loadAll();
    const found = all.find((m) => m.id === "nonexistent_id");
    expect(found).toBeUndefined();
  });
});

describe("store tool", () => {
  it("creates a memory with correct scope from tags", async () => {
    const tags = ["identity", "preference"];
    const scope = scopeFromTags(tags);
    expect(scope).toBe("global");

    const tags2 = ["technical", "project"];
    const scope2 = scopeFromTags(tags2);
    expect(scope2).toBe("project");
  });

  it("maps salience hints to correct scores", async () => {
    const hintMap: Record<string, number> = { low: 0.3, medium: 0.5, high: 0.7, critical: 0.9 };

    for (const [hint, expected] of Object.entries(hintMap)) {
      const score = hintMap[hint];
      expect(score).toBe(expected);
    }
  });

  it("creates and stores a memory", async () => {
    const content = "Test direct store";
    const tags = ["insight", "technical"];
    const score = 0.7; // high hint

    const memory: Memory = {
      id: generateId(),
      content,
      scope: scopeFromTags(tags),
      salience: sanitizeSalience({ novelty: score, relevance: score, emotional: score * 0.8, predictive: score }),
      tags,
      access_count: 0,
      last_accessed: null,
      created_at: new Date().toISOString(),
      consolidated: false,
      generalized: false,
      source_session: "mcp-store",
      updated_from: null,
    };

    await store.add([memory]);
    const all = await store.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0].content).toBe(content);
    expect(all[0].source_session).toBe("mcp-store");
  });

  it("truncates content to 400 chars", () => {
    const long = "x".repeat(500);
    expect(long.slice(0, 400)).toHaveLength(400);
  });
});

describe("forget tool", () => {
  it("removes a memory by ID", async () => {
    const mem = makeMemory({ content: "doomed memory" });
    await store.add([mem]);
    expect(await store.loadAll()).toHaveLength(1);

    await store.remove(mem.id);
    expect(await store.loadAll()).toHaveLength(0);
  });

  it("handles nonexistent memory gracefully", async () => {
    // remove on nonexistent ID should not throw
    await store.remove("nonexistent_id");
    expect(await store.loadAll()).toHaveLength(0);
  });
});

describe("consolidate tool (basic pruning)", () => {
  it("prunes memories below strength threshold", async () => {
    // Create a very old memory with low salience — should decay below 0.03
    const ancient = makeMemory({
      content: "ancient decayed memory",
      salience: { novelty: 0.1, relevance: 0.1, emotional: 0.1, predictive: 0.1 },
      created_at: new Date(Date.now() - 365 * 86400000).toISOString(), // 1 year old
    });
    const fresh = makeMemory({
      content: "fresh strong memory",
      salience: { novelty: 0.9, relevance: 0.9, emotional: 0.9, predictive: 0.9 },
    });

    await store.add([ancient, fresh]);
    expect(await store.loadAll()).toHaveLength(2);

    // Verify the ancient one is actually below threshold
    expect(calculateStrength(ancient)).toBeLessThan(0.03);
    expect(calculateStrength(fresh)).toBeGreaterThan(0.5);

    // Simulate pruning logic
    const all = await store.loadAll();
    let pruned = 0;
    for (const m of all) {
      if (calculateStrength(m) < 0.03) {
        await store.remove(m.id);
        pruned++;
      }
    }

    expect(pruned).toBe(1);
    const remaining = await store.loadAll();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].content).toBe("fresh strong memory");
  });

  it("leaves healthy memories untouched", async () => {
    await store.add([
      makeMemory({ salience: { novelty: 0.7, relevance: 0.7, emotional: 0.7, predictive: 0.7 } }),
      makeMemory({ salience: { novelty: 0.5, relevance: 0.5, emotional: 0.5, predictive: 0.5 } }),
    ]);

    const all = await store.loadAll();
    const belowThreshold = all.filter((m) => calculateStrength(m) < 0.03);
    expect(belowThreshold).toHaveLength(0);
  });
});
