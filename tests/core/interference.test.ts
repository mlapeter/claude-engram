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
    const old = makeMemory({ id: "old1", salience: { novelty: 1.0, relevance: 1.0, emotional: 1.0, predictive: 1.0 } });
    await store.add([old]);

    const newMem = makeMemory({ id: "new1", updated_from: "old1" });
    const count = await applyInterference([newMem], [old], store);

    expect(count).toBe(1);
    const loaded = await store.load("project");
    const updated = loaded.find((m) => m.id === "old1")!;
    expect(updated.salience.novelty).toBeCloseTo(0.7);
    expect(updated.salience.relevance).toBeCloseTo(0.7);
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
});
