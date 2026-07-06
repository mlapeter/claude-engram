import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore } from "../../src/core/store.js";
import { applyInterference } from "../../src/core/interference.js";
import type { Memory } from "../../src/core/types.js";
import { resetConfig } from "../../src/core/config.js";

let tempDir: string;

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    content: "test memory",
    scope: "project",
    salience: { novelty: 0.8, relevance: 0.8, emotional: 0.6, predictive: 0.5 },
    tags: ["project"],
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
  tempDir = mkdtempSync(join(tmpdir(), "engram-test-"));
  process.env.ENGRAM_DATA_DIR = tempDir;
  resetConfig();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.ENGRAM_DATA_DIR;
});

describe("applyInterference", () => {
  it("weakens salience of superseded memory by interference factor", async () => {
    const store = createStore("/test");
    const old = makeMemory({ id: "old1", register: "person", salience: { novelty: 1.0, relevance: 1.0, emotional: 1.0, predictive: 1.0 } });
    await store.add([old]);

    const newMem = makeMemory({ id: "new1", register: "person", updated_from: "old1" });
    const count = await applyInterference([newMem], [old], store);

    expect(count).toBe(1);
    const loaded = await store.load("project");
    const updated = loaded.find((m) => m.id === "old1")!;
    expect(updated.salience.novelty).toBeCloseTo(0.7);
    expect(updated.salience.relevance).toBeCloseTo(0.7);
  });

  it("never weakens across registers — a craft update can't damp a person memory", async () => {
    const store = createStore("/test");
    const old = makeMemory({ id: "old-person", register: "person", salience: { novelty: 1.0, relevance: 1.0, emotional: 1.0, predictive: 1.0 } });
    await store.add([old]);

    const newMem = makeMemory({ id: "new-craft", register: "craft", updated_from: "old-person" });
    const count = await applyInterference([newMem], [old], store);

    expect(count).toBe(0);
    const loaded = await store.load("project");
    expect(loaded.find((m) => m.id === "old-person")!.salience.novelty).toBe(1.0);
  });

  it("skips memories without updated_from", async () => {
    const store = createStore("/test");
    const old = makeMemory({ id: "old2" });
    await store.add([old]);

    const newMem = makeMemory({ id: "new2", updated_from: null });
    const count = await applyInterference([newMem], [old], store);

    expect(count).toBe(0);
  });

  it("skips when referenced memory does not exist", async () => {
    const store = createStore("/test");
    const newMem = makeMemory({ id: "new3", updated_from: "nonexistent" });
    const count = await applyInterference([newMem], [], store);

    expect(count).toBe(0);
  });

  it("multiple updates compound but salience never drops below 0.1 floor", async () => {
    const store = createStore("/test");
    const old = makeMemory({
      id: "old_compound",
      salience: { novelty: 1.0, relevance: 1.0, emotional: 1.0, predictive: 1.0 },
    });
    await store.add([old]);

    // Simulate 5 successive updates to the same memory
    for (let i = 0; i < 5; i++) {
      const existing = await store.load("project");
      const current = existing.find((m) => m.id === "old_compound")!;
      const newMem = makeMemory({ id: `new_c${i}`, updated_from: "old_compound" });
      await applyInterference([newMem], [current], store);
    }

    const loaded = await store.load("project");
    const updated = loaded.find((m) => m.id === "old_compound")!;
    // After 5x interference at 0.7: 0.7^5 = 0.168, but floor is 0.1
    // Some dimensions should hit the floor
    expect(updated.salience.novelty).toBeGreaterThanOrEqual(0.1);
    expect(updated.salience.relevance).toBeGreaterThanOrEqual(0.1);
    expect(updated.salience.emotional).toBeGreaterThanOrEqual(0.1);
    expect(updated.salience.predictive).toBeGreaterThanOrEqual(0.1);
  });

  it("single interference weakens each dimension independently", async () => {
    const store = createStore("/test");
    const old = makeMemory({
      id: "old_dims",
      salience: { novelty: 1.0, relevance: 0.5, emotional: 0.2, predictive: 0.8 },
    });
    await store.add([old]);

    const newMem = makeMemory({ id: "new_dims", updated_from: "old_dims" });
    await applyInterference([newMem], [old], store);

    const loaded = await store.load("project");
    const updated = loaded.find((m) => m.id === "old_dims")!;
    expect(updated.salience.novelty).toBeCloseTo(0.7);
    expect(updated.salience.relevance).toBeCloseTo(0.35);
    expect(updated.salience.emotional).toBeCloseTo(0.14);
    expect(updated.salience.predictive).toBeCloseTo(0.56);
  });
});
