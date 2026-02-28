import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore, type MemoryStore } from "../../src/core/store.js";
import { calculateStrength } from "../../src/core/strength.js";
import { generateId } from "../../src/core/types.js";
import type { Memory } from "../../src/core/types.js";

let tmpDir: string;
let store: MemoryStore;

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: generateId(),
    content: "Test memory",
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
  tmpDir = mkdtempSync(join(tmpdir(), "engram-consol-test-"));
  process.env.ENGRAM_DATA_DIR = tmpDir;
  store = createStore("/test/project");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ENGRAM_DATA_DIR;
});

describe("consolidation - auto-pruning", () => {
  it("prunes memories below 0.03 strength threshold", async () => {
    const ancient = makeMemory({
      content: "ancient decayed",
      salience: { novelty: 0.1, relevance: 0.1, emotional: 0.1, predictive: 0.1 },
      created_at: new Date(Date.now() - 365 * 86400000).toISOString(),
    });
    const fresh = makeMemory({
      content: "fresh healthy",
      salience: { novelty: 0.9, relevance: 0.9, emotional: 0.9, predictive: 0.9 },
    });

    await store.add([ancient, fresh]);
    expect(calculateStrength(ancient)).toBeLessThan(0.03);
    expect(calculateStrength(fresh)).toBeGreaterThan(0.5);

    // Simulate auto-pruning logic
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
    expect(remaining[0].content).toBe("fresh healthy");
  });
});

describe("consolidation - backup", () => {
  it("creates backup before consolidation", async () => {
    await store.add([makeMemory({ content: "mem1" }), makeMemory({ content: "mem2" })]);

    const backupPath = await store.backup();
    expect(backupPath).toContain("memories-");
    expect(backupPath).toContain(".json");
  });
});

describe("consolidation - merge logic", () => {
  it("applies merge: removes sources, adds merged memory", async () => {
    const mem1 = makeMemory({ id: "id_a", content: "Mike's name is Mike", tags: ["identity"] });
    const mem2 = makeMemory({ id: "id_b", content: "User's name is Mike", tags: ["identity"] });
    const mem3 = makeMemory({ id: "id_c", content: "Project uses TypeScript", tags: ["technical"] });

    await store.add([mem1, mem2, mem3]);
    expect(await store.loadAll()).toHaveLength(3);

    // Simulate applying a merge result
    await store.remove("id_a");
    await store.remove("id_b");
    const merged = makeMemory({
      content: "User's name is Mike. Prefers first name.",
      tags: ["identity"],
      consolidated: true,
      access_count: mem1.access_count + mem2.access_count,
    });
    await store.add([merged]);

    const all = await store.loadAll();
    expect(all).toHaveLength(2);
    expect(all.some((m) => m.content.includes("Mike. Prefers"))).toBe(true);
    expect(all.some((m) => m.content === "Project uses TypeScript")).toBe(true);
  });
});

describe("consolidation - generalization", () => {
  it("adds generalized pattern memories", async () => {
    await store.add([
      makeMemory({ content: "User chose simple DNS redirect" }),
      makeMemory({ content: "User chose Haiku over Sonnet for cost" }),
      makeMemory({ content: "User chose bun for speed" }),
    ]);

    // Simulate adding a generalized memory
    const pattern = makeMemory({
      content: "User consistently prefers simpler, more efficient solutions over complex alternatives",
      tags: ["pattern", "preference"],
      consolidated: true,
      generalized: true,
    });
    await store.add([pattern]);

    const all = await store.loadAll();
    expect(all).toHaveLength(4);
    expect(all.filter((m) => m.generalized)).toHaveLength(1);
    expect(all.find((m) => m.generalized)?.content).toContain("simpler");
  });
});

describe("consolidation - prune application", () => {
  it("removes pruned IDs that still exist", async () => {
    const mem1 = makeMemory({ id: "keep_me", content: "important" });
    const mem2 = makeMemory({ id: "prune_me", content: "trivial duplicate" });

    await store.add([mem1, mem2]);

    // Simulate prune
    await store.remove("prune_me");

    const all = await store.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("keep_me");
  });

  it("skips prune IDs that were already merged away", async () => {
    const mem = makeMemory({ id: "already_gone", content: "was merged" });
    await store.add([mem]);
    await store.remove("already_gone");

    // Should not throw when trying to remove again
    await store.remove("already_gone");
    expect(await store.loadAll()).toHaveLength(0);
  });
});

describe("consolidation - meta update", () => {
  it("updates lastConsolidation timestamp", async () => {
    const before = await store.loadMeta("global");
    expect(before.lastConsolidation).toBeNull();

    const meta = { ...before, lastConsolidation: new Date().toISOString() };
    await store.saveMeta("global", meta);

    const after = await store.loadMeta("global");
    expect(after.lastConsolidation).not.toBeNull();
  });
});

describe("consolidation - edge cases", () => {
  it("handles empty memory store", async () => {
    const all = await store.loadAll();
    expect(all).toHaveLength(0);
    // Should not crash
    const backupPath = await store.backup();
    expect(backupPath).toBeTruthy();
  });

  it("preserves scope when merging", async () => {
    const mem1 = makeMemory({ id: "p1", content: "project detail 1", scope: "project" });
    const mem2 = makeMemory({ id: "p2", content: "project detail 2", scope: "project" });
    await store.add([mem1, mem2]);

    await store.remove("p1");
    await store.remove("p2");
    const merged = makeMemory({
      content: "Combined project detail",
      scope: "project",
      consolidated: true,
    });
    await store.add([merged]);

    const all = await store.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0].scope).toBe("project");
  });
});
