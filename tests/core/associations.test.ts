import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore, type MemoryStore } from "../../src/core/store.js";
import { generateId } from "../../src/core/types.js";
import type { Memory } from "../../src/core/types.js";
import { resetConfig } from "../../src/core/config.js";
import { writeAssociationEdges } from "../../src/core/consolidation.js";

let tempDir: string;
let store: MemoryStore;

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: generateId(),
    content: "test memory content",
    scope: "project",
    memory_type: "episodic",
    salience: { novelty: 0.8, relevance: 0.7, emotional: 0.3, predictive: 0.5 },
    tags: ["technical"],
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
  tempDir = mkdtempSync(join(tmpdir(), "engram-assoc-test-"));
  process.env.ENGRAM_DATA_DIR = tempDir;
  delete process.env.VOYAGE_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  writeFileSync(join(tempDir, "config.json"), JSON.stringify({ memoryHistory: false }));
  resetConfig();
  store = createStore(process.cwd());
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.ENGRAM_DATA_DIR;
  delete process.env.VOYAGE_API_KEY;
  resetConfig();
});

describe("association edges — store layer", () => {
  it("writes symmetric edges and follows them from both ends", async () => {
    const m1 = makeMemory({ id: "m_1_aaaa" });
    const m2 = makeMemory({ id: "m_2_bbbb" });
    await store.save("project", [m1, m2]);

    const written = await store.addAssociationEdges([{ a: "m_1_aaaa", b: "m_2_bbbb", w: 0.9 }]);
    expect(written).toBe(1);

    const fromA = await store.getAssociatedMemories("m_1_aaaa");
    expect(fromA).toHaveLength(1);
    expect(fromA[0].memory.id).toBe("m_2_bbbb");
    expect(fromA[0].w).toBe(0.9);

    const fromB = await store.getAssociatedMemories("m_2_bbbb");
    expect(fromB[0].memory.id).toBe("m_1_aaaa");
  });

  it("rejects pairs whose endpoints are not both active in one scope", async () => {
    const m1 = makeMemory({ id: "m_1_aaaa", scope: "project" });
    const m2 = makeMemory({ id: "m_2_glob", scope: "global" });
    await store.save("project", [m1]);
    await store.save("global", [m2]);

    // cross-scope pair and a pair with a missing endpoint
    const written = await store.addAssociationEdges([
      { a: "m_1_aaaa", b: "m_2_glob", w: 0.9 },
      { a: "m_1_aaaa", b: "m_9_gone", w: 0.9 },
    ]);
    expect(written).toBe(0);
    expect(await store.getAssociatedMemories("m_1_aaaa")).toHaveLength(0);
  });

  it("caps edges per memory, evicting the weakest", async () => {
    const hub = makeMemory({ id: "m_0_hub" });
    const spokes = Array.from({ length: 8 }, (_, i) => makeMemory({ id: `m_${i + 1}_spoke` }));
    await store.save("project", [hub, ...spokes]);

    await store.addAssociationEdges(spokes.map((s, i) => ({ a: "m_0_hub", b: s.id, w: 0.5 + i * 0.05 })));

    const linked = await store.getAssociatedMemories("m_0_hub", 10);
    expect(linked).toHaveLength(6); // cap
    // strongest survive, weakest two evicted
    expect(linked[0].w).toBeCloseTo(0.85);
    expect(linked.every((l) => l.w >= 0.6)).toBe(true);
  });

  it("updates weight to max on duplicate edge instead of duplicating", async () => {
    const m1 = makeMemory({ id: "m_1_aaaa" });
    const m2 = makeMemory({ id: "m_2_bbbb" });
    await store.save("project", [m1, m2]);

    await store.addAssociationEdges([{ a: "m_1_aaaa", b: "m_2_bbbb", w: 0.7 }]);
    await store.addAssociationEdges([{ a: "m_1_aaaa", b: "m_2_bbbb", w: 0.85 }]);

    const linked = await store.getAssociatedMemories("m_1_aaaa");
    expect(linked).toHaveLength(1);
    expect(linked[0].w).toBe(0.85);
  });

  it("archiveMemories purges edges touching the archived id", async () => {
    const m1 = makeMemory({ id: "m_1_aaaa" });
    const m2 = makeMemory({ id: "m_2_bbbb" });
    const m3 = makeMemory({ id: "m_3_cccc" });
    await store.save("project", [m1, m2, m3]);
    await store.addAssociationEdges([
      { a: "m_1_aaaa", b: "m_2_bbbb", w: 0.9 },
      { a: "m_1_aaaa", b: "m_3_cccc", w: 0.8 },
    ]);

    await store.archiveMemories(["m_2_bbbb"]);

    const linked = await store.getAssociatedMemories("m_1_aaaa");
    expect(linked).toHaveLength(1);
    expect(linked[0].memory.id).toBe("m_3_cccc");
    // the archived memory's own edge list is gone too
    expect(await store.getAssociatedMemories("m_2_bbbb")).toHaveLength(0);
  });

  it("remove() purges edges", async () => {
    const m1 = makeMemory({ id: "m_1_aaaa" });
    const m2 = makeMemory({ id: "m_2_bbbb" });
    await store.save("project", [m1, m2]);
    await store.addAssociationEdges([{ a: "m_1_aaaa", b: "m_2_bbbb", w: 0.9 }]);

    await store.remove("m_2_bbbb");

    expect(await store.getAssociatedMemories("m_1_aaaa")).toHaveLength(0);
  });
});

describe("writeAssociationEdges — sleep writes related-but-distinct", () => {
  it("writes edges for similar same-scope survivors, skips dissimilar and cross-scope", async () => {
    process.env.VOYAGE_API_KEY = "test-key"; // enables embeddings; no API call happens here
    resetConfig();

    const m1 = makeMemory({ id: "m_1_aaaa", scope: "project", content: "buffer design discussion" });
    const m2 = makeMemory({ id: "m_2_bbbb", scope: "project", content: "buffer design follow-up" });
    const m3 = makeMemory({ id: "m_3_far", scope: "project", content: "unrelated topic" });
    const m4 = makeMemory({ id: "m_4_glob", scope: "global", content: "buffer design but global" });
    await store.save("project", [m1, m2, m3]);
    await store.save("global", [m4]);

    // Hand-built index: m1/m2/m4 nearly parallel, m3 orthogonal
    const paths = store.getEmbeddingPaths();
    writeFileSync(paths.project, JSON.stringify({
      m_1_aaaa: [1, 0, 0],
      m_2_bbbb: [0.98, 0.02, 0],
      m_3_far: [0, 1, 0],
    }));
    writeFileSync(paths.global, JSON.stringify({
      m_4_glob: [0.99, 0.01, 0],
    }));

    const count = await writeAssociationEdges(store, [m1, m2, m3, m4], null);
    expect(count).toBe(1); // only m1↔m2: m3 dissimilar, m4 cross-scope

    const linked = await store.getAssociatedMemories("m_1_aaaa");
    expect(linked).toHaveLength(1);
    expect(linked[0].memory.id).toBe("m_2_bbbb");
    expect(linked[0].w).toBeGreaterThan(0.95);
    expect(await store.getAssociatedMemories("m_3_far")).toHaveLength(0);
  });

  it("returns 0 without embeddings (token-overlap mode has no honest weight)", async () => {
    delete process.env.VOYAGE_API_KEY;
    resetConfig();
    const m1 = makeMemory({ id: "m_1_aaaa" });
    const m2 = makeMemory({ id: "m_2_bbbb" });
    await store.save("project", [m1, m2]);

    expect(await writeAssociationEdges(store, [m1, m2], null)).toBe(0);
  });

  it("never links across registers even when vectors are similar", async () => {
    process.env.VOYAGE_API_KEY = "test-key";
    resetConfig();

    const craft = makeMemory({ id: "m_1_craft", tags: ["technical"] });
    const person = makeMemory({ id: "m_2_pers", tags: ["relationship", "personal"], register: "person" });
    await store.save("project", [craft, person]);

    const paths = store.getEmbeddingPaths();
    writeFileSync(paths.project, JSON.stringify({
      m_1_craft: [1, 0],
      m_2_pers: [0.99, 0.01],
    }));

    expect(await writeAssociationEdges(store, [craft, person], null)).toBe(0);
  });
});
