import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore } from "../../src/core/store.js";
import { calculateStrength } from "../../src/core/strength.js";
import { runConsolidation } from "../../src/core/consolidation.js";
import type { Memory } from "../../src/core/types.js";
import { generateId, projectHash } from "../../src/core/types.js";
import { resetConfig } from "../../src/core/config.js";

let tempDir: string;

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: generateId(),
    content: "test memory content",
    scope: "project",
    salience: { novelty: 0.8, relevance: 0.7, emotional: 0.6, predictive: 0.5 },
    tags: ["project"],
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

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "engram-archive-test-"));
  process.env.ENGRAM_DATA_DIR = tempDir;
  delete process.env.VOYAGE_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  resetConfig();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.ENGRAM_DATA_DIR;
  delete process.env.VOYAGE_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  resetConfig();
  vi.restoreAllMocks();
});

describe("Deep Archive — archiveMemories", () => {
  it("moves memories from active store to archive file", async () => {
    const store = createStore(process.cwd());
    const m1 = makeMemory({ scope: "project", content: "to be archived" });
    const m2 = makeMemory({ scope: "project", content: "stays active" });
    await store.add([m1, m2]);

    const count = await store.archiveMemories([m1.id]);

    expect(count).toBe(1);

    const active = await store.load("project");
    expect(active.length).toBe(1);
    expect(active[0].id).toBe(m2.id);

    const archive = await store.loadArchive("project");
    expect(archive.length).toBe(1);
    expect(archive[0].id).toBe(m1.id);
    expect(archive[0].archived).toBe(true);
    expect(archive[0].archived_at).toBeTruthy();
  });

  it("returns zero for empty input", async () => {
    const store = createStore(process.cwd());
    const count = await store.archiveMemories([]);
    expect(count).toBe(0);
  });

  it("preserves all memory fields except archived flag", async () => {
    const store = createStore(process.cwd());
    const m = makeMemory({
      scope: "global",
      content: "preserve me",
      tags: ["identity", "preference"],
      access_count: 5,
    });
    await store.add([m]);
    await store.archiveMemories([m.id]);

    const archive = await store.loadArchive("global");
    expect(archive[0].content).toBe("preserve me");
    expect(archive[0].tags).toEqual(["identity", "preference"]);
    expect(archive[0].access_count).toBe(5);
    expect(archive[0].salience).toEqual(m.salience);
  });

  it("creates a deep_archive.json file in the scope directory", async () => {
    const store = createStore(process.cwd());
    const m = makeMemory({ scope: "project" });
    await store.add([m]);
    await store.archiveMemories([m.id]);

    const projectArchivePath = join(
      tempDir,
      "projects",
      projectHash(process.cwd()),
      "deep_archive.json",
    );
    expect(existsSync(projectArchivePath)).toBe(true);
    const contents = JSON.parse(readFileSync(projectArchivePath, "utf-8"));
    expect(Array.isArray(contents)).toBe(true);
    expect(contents.length).toBe(1);
  });

  it("handles mixed scope archive batch", async () => {
    const store = createStore(process.cwd());
    const globalMem = makeMemory({ scope: "global", tags: ["identity"] });
    const projectMem = makeMemory({ scope: "project", tags: ["technical"] });
    await store.add([globalMem, projectMem]);

    const count = await store.archiveMemories([globalMem.id, projectMem.id]);
    expect(count).toBe(2);

    expect((await store.load("global")).length).toBe(0);
    expect((await store.load("project")).length).toBe(0);
    expect((await store.loadArchive("global")).length).toBe(1);
    expect((await store.loadArchive("project")).length).toBe(1);
  });
});

describe("Deep Archive — reactivateMemory", () => {
  it("moves memory back to active store with refreshed access", async () => {
    const store = createStore(process.cwd());
    const m = makeMemory({ scope: "project", access_count: 2 });
    await store.add([m]);
    await store.archiveMemories([m.id]);

    const reactivated = await store.reactivateMemory(m.id);

    expect(reactivated).not.toBeNull();
    expect(reactivated!.archived).toBe(false);
    expect(reactivated!.archived_at).toBeNull();
    expect(reactivated!.last_accessed).toBeTruthy();
    expect(reactivated!.access_count).toBe(3);

    expect((await store.load("project")).length).toBe(1);
    expect((await store.loadArchive("project")).length).toBe(0);
  });

  it("returns null for non-existent archived memory", async () => {
    const store = createStore(process.cwd());
    const result = await store.reactivateMemory("m_nonexistent");
    expect(result).toBeNull();
  });

  it("preserves content and tags through archive/reactivate cycle", async () => {
    const store = createStore(process.cwd());
    const original = makeMemory({
      scope: "global",
      content: "round trip content",
      tags: ["identity", "self-reflection"],
    });
    await store.add([original]);
    await store.archiveMemories([original.id]);
    const recovered = await store.reactivateMemory(original.id);

    expect(recovered!.content).toBe("round trip content");
    expect(recovered!.tags).toEqual(["identity", "self-reflection"]);
  });
});

describe("Deep Archive — deepRecall", () => {
  it("returns empty for empty archive", async () => {
    const store = createStore(process.cwd());
    const results = await store.deepRecall("anything");
    expect(results).toEqual([]);
  });

  it("finds archived memories via exact substring match", async () => {
    const store = createStore(process.cwd());
    const m = makeMemory({
      scope: "project",
      content: "the unique phrase needle in the haystack",
    });
    await store.add([m]);
    await store.archiveMemories([m.id]);

    const results = await store.deepRecall("unique phrase needle");
    expect(results.length).toBe(1);
    expect(results[0].id).toBe(m.id);
  });

  it("does not surface active memories", async () => {
    const store = createStore(process.cwd());
    const active = makeMemory({ scope: "project", content: "this is active" });
    await store.add([active]);

    const results = await store.deepRecall("active");
    expect(results.length).toBe(0);
  });

  it("respects limit", async () => {
    const store = createStore(process.cwd());
    const memories = Array.from({ length: 10 }, (_, i) =>
      makeMemory({ scope: "project", content: `match keyword item number ${i}` }),
    );
    await store.add(memories);
    await store.archiveMemories(memories.map((m) => m.id));

    const results = await store.deepRecall("keyword item", { limit: 3 });
    expect(results.length).toBe(3);
  });

  it("requires strong specificity (filters weak matches)", async () => {
    const store = createStore(process.cwd());
    const m = makeMemory({
      scope: "project",
      content: "alpha beta gamma delta epsilon zeta eta theta",
    });
    await store.add([m]);
    await store.archiveMemories([m.id]);

    // Very low overlap should be filtered (default minSpecificity = 0.5)
    const results = await store.deepRecall("zzz", { minSpecificity: 0.5 });
    expect(results.length).toBe(0);
  });
});

describe("Archive decay rate", () => {
  it("computes lower decay for archived memories than active", () => {
    const oldDate = new Date(Date.now() - 60 * 86_400_000).toISOString(); // 60 days ago
    const active = makeMemory({
      created_at: oldDate,
      archived: false,
    });
    const archived = makeMemory({
      created_at: oldDate,
      archived: true,
    });

    const activeStrength = calculateStrength(active);
    const archivedStrength = calculateStrength(archived);

    // Archived should retain more strength after the same age (lower decay rate)
    expect(archivedStrength).toBeGreaterThan(activeStrength);
  });

  it("archived memories retain meaningful strength over long timespans", () => {
    const oneYearAgo = new Date(Date.now() - 365 * 86_400_000).toISOString();
    const archived = makeMemory({
      created_at: oneYearAgo,
      archived: true,
      salience: { novelty: 0.9, relevance: 0.9, emotional: 0.9, predictive: 0.9 },
    });

    const strength = calculateStrength(archived);
    // With archive decay rate 0.001 × √365 ≈ 0.019, salience avg 0.9 → strength ≈ 0.88
    expect(strength).toBeGreaterThan(0.5);
  });
});

describe("Consolidation integration with archive", () => {
  it("migrates auto-pruned memories to archive instead of deleting", async () => {
    const store = createStore(process.cwd());

    // Memory with very low salience and old creation date — strength below 0.03 threshold
    const veryOldDate = new Date(Date.now() - 365 * 86_400_000).toISOString();
    const weakMemory = makeMemory({
      scope: "project",
      content: "weak old memory",
      salience: { novelty: 0.05, relevance: 0.05, emotional: 0.05, predictive: 0.05 },
      created_at: veryOldDate,
    });

    // A strong memory that won't be pruned
    const strongMemory = makeMemory({
      scope: "project",
      content: "strong recent memory",
      salience: { novelty: 0.9, relevance: 0.9, emotional: 0.9, predictive: 0.9 },
    });

    await store.add([weakMemory, strongMemory]);

    // Strength of weak memory should be below prune threshold
    expect(calculateStrength(weakMemory)).toBeLessThan(0.03);

    await runConsolidation(store);

    // Weak memory should be in archive, not active store
    const active = await store.load("project");
    const archive = await store.loadArchive("project");

    expect(active.find((m) => m.id === weakMemory.id)).toBeUndefined();
    expect(archive.find((m) => m.id === weakMemory.id)).toBeDefined();
    expect(active.find((m) => m.id === strongMemory.id)).toBeDefined();
  });
});
