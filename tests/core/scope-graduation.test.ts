import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore, type MemoryStore } from "../../src/core/store.js";
import { applyConsolidation } from "../../src/core/consolidation.js";
import { generateId } from "../../src/core/types.js";
import type { Memory } from "../../src/core/types.js";
import { resetConfig } from "../../src/core/config.js";

let tempDir: string;
let store: MemoryStore;

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: generateId(),
    content: "test memory content",
    scope: "project",
    memory_type: "episodic",
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

const SALIENCE = { novelty: 0.5, relevance: 0.5, emotional: 0.5, predictive: 0.5 };

function emptyResult() {
  return { merge: [], generalize: [], prune_ids: [], notes: "" };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "engram-graduation-test-"));
  process.env.ENGRAM_DATA_DIR = tempDir;
  delete process.env.VOYAGE_API_KEY;
  resetConfig();
  store = createStore(process.cwd());
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.ENGRAM_DATA_DIR;
  resetConfig();
});

describe("scope graduation — merge scope override", () => {
  it("promotes a merge to global when the model says so, even from all-project sources", async () => {
    const m1 = makeMemory({ id: "m_1_aaaa", scope: "project", content: "Mike prefers rigorous thinking, said at work" });
    const m2 = makeMemory({ id: "m_2_bbbb", scope: "project", content: "Mike values rigor before implementation" });
    await store.add([m1, m2]);

    await applyConsolidation(store, [m1, m2], {
      ...emptyResult(),
      merge: [{
        ids: ["m_1_aaaa", "m_2_bbbb"],
        merged: {
          scope: "global",
          content: "Mike values rigorous thinking before implementation",
          salience: SALIENCE,
          tags: ["relationship"],
        },
      }],
    }, 0, 0);

    const all = await store.loadAll();
    const merged = all.find((m) => m.consolidated);
    expect(merged).toBeTruthy();
    expect(merged!.scope).toBe("global");
    expect(all.find((m) => m.id === "m_1_aaaa")).toBeUndefined();
    expect(all.find((m) => m.id === "m_2_bbbb")).toBeUndefined();
  });

  it("keeps a merge project-scoped when the model explicitly says project", async () => {
    const m1 = makeMemory({ id: "m_1_aaaa", scope: "project" });
    const m2 = makeMemory({ id: "m_2_bbbb", scope: "project" });
    await store.add([m1, m2]);

    await applyConsolidation(store, [m1, m2], {
      ...emptyResult(),
      merge: [{
        ids: ["m_1_aaaa", "m_2_bbbb"],
        merged: { scope: "project", content: "uses vitest for tests", salience: SALIENCE, tags: ["technical"] },
      }],
    }, 0, 0);

    const merged = (await store.loadAll()).find((m) => m.consolidated);
    expect(merged!.scope).toBe("project");
  });
});

describe("scope graduation — any-source-global fallback", () => {
  it("falls back to global when no scope is given and any source is global", async () => {
    const m1 = makeMemory({ id: "m_1_aaaa", scope: "global" });
    const m2 = makeMemory({ id: "m_2_bbbb", scope: "project" });
    await store.add([m1, m2]);

    await applyConsolidation(store, [m1, m2], {
      ...emptyResult(),
      merge: [{
        ids: ["m_1_aaaa", "m_2_bbbb"],
        merged: { content: "merged without explicit scope", salience: SALIENCE, tags: ["insight"] },
      }],
    }, 0, 0);

    const merged = (await store.loadAll()).find((m) => m.consolidated);
    expect(merged!.scope).toBe("global");
  });

  it("stays project-scoped when no scope is given and all sources are project", async () => {
    const m1 = makeMemory({ id: "m_1_aaaa", scope: "project" });
    const m2 = makeMemory({ id: "m_2_bbbb", scope: "project" });
    await store.add([m1, m2]);

    await applyConsolidation(store, [m1, m2], {
      ...emptyResult(),
      merge: [{
        ids: ["m_1_aaaa", "m_2_bbbb"],
        merged: { content: "merged without explicit scope", salience: SALIENCE, tags: ["technical"] },
      }],
    }, 0, 0);

    const merged = (await store.loadAll()).find((m) => m.consolidated);
    expect(merged!.scope).toBe("project");
  });
});

describe("applyConsolidation mechanics", () => {
  it("merged memory keeps oldest created_at and summed access_count, becomes semantic", async () => {
    const m1 = makeMemory({ id: "m_1_aaaa", created_at: "2026-01-01T00:00:00.000Z", access_count: 3 });
    const m2 = makeMemory({ id: "m_2_bbbb", created_at: "2026-06-01T00:00:00.000Z", access_count: 4 });
    await store.add([m1, m2]);

    await applyConsolidation(store, [m1, m2], {
      ...emptyResult(),
      merge: [{
        ids: ["m_1_aaaa", "m_2_bbbb"],
        merged: { content: "merged", salience: SALIENCE, tags: ["pattern"] },
      }],
    }, 0, 0);

    const merged = (await store.loadAll()).find((m) => m.consolidated)!;
    expect(merged.created_at).toBe("2026-01-01T00:00:00.000Z");
    expect(merged.access_count).toBe(7);
    expect(merged.memory_type).toBe("semantic");
  });

  it("skips merges with fewer than two surviving sources", async () => {
    const m1 = makeMemory({ id: "m_1_aaaa" });
    await store.add([m1]);

    const result = await applyConsolidation(store, [m1], {
      ...emptyResult(),
      merge: [{
        ids: ["m_1_aaaa", "m_gone_zzzz"],
        merged: { content: "should not exist", salience: SALIENCE, tags: ["pattern"] },
      }],
    }, 0, 0);

    expect(result.mergeCount).toBe(0);
    expect(await store.loadAll()).toHaveLength(1);
  });

  it("generalized memories are created global", async () => {
    const m1 = makeMemory({ id: "m_1_aaaa", scope: "project" });
    await store.add([m1]);

    await applyConsolidation(store, [m1], {
      ...emptyResult(),
      generalize: [{ content: "a recurring pattern", salience: SALIENCE, tags: ["pattern"] }],
    }, 0, 0);

    const gen = (await store.loadAll()).find((m) => m.generalized)!;
    expect(gen.scope).toBe("global");
  });

  it("pruned memories go to the deep archive, not deletion", async () => {
    const m1 = makeMemory({ id: "m_1_aaaa", scope: "project", content: "trivial" });
    await store.add([m1]);

    await applyConsolidation(store, [m1], {
      ...emptyResult(),
      prune_ids: ["m_1_aaaa"],
    }, 0, 0);

    expect(await store.loadAll()).toHaveLength(0);
    const archived = await store.loadArchive("project");
    expect(archived.map((m) => m.id)).toContain("m_1_aaaa");
  });
});
