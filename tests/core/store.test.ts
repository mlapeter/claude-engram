import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore } from "../../src/core/store.js";
import type { Memory } from "../../src/core/types.js";
import { generateId } from "../../src/core/types.js";

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
  tempDir = mkdtempSync(join(tmpdir(), "engram-test-"));
  process.env.ENGRAM_DATA_DIR = tempDir;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.ENGRAM_DATA_DIR;
});

describe("MemoryStore", () => {
  it("empty store returns empty array", async () => {
    const store = createStore("/test/project");
    const memories = await store.loadAll();
    expect(memories).toEqual([]);
  });

  it("add and load memories", async () => {
    const store = createStore("/test/project");
    const mem = makeMemory({ content: "hello world" });
    await store.add([mem]);

    const loaded = await store.load("project");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].content).toBe("hello world");
  });

  it("routes memories to correct store by scope", async () => {
    const store = createStore("/test/project");
    const globalMem = makeMemory({ scope: "global", content: "user prefers bun" });
    const projectMem = makeMemory({ scope: "project", content: "uses vitest" });
    await store.add([globalMem, projectMem]);

    const global = await store.load("global");
    const project = await store.load("project");
    expect(global).toHaveLength(1);
    expect(global[0].content).toBe("user prefers bun");
    expect(project).toHaveLength(1);
    expect(project[0].content).toBe("uses vitest");
  });

  it("loadAll returns both global and project", async () => {
    const store = createStore("/test/project");
    await store.add([
      makeMemory({ scope: "global", content: "g1" }),
      makeMemory({ scope: "project", content: "p1" }),
    ]);

    const all = await store.loadAll();
    expect(all).toHaveLength(2);
  });

  it("remove deletes a memory", async () => {
    const store = createStore("/test/project");
    const mem = makeMemory({ id: "m_remove_test" });
    await store.add([mem]);
    await store.remove("m_remove_test");

    const loaded = await store.load("project");
    expect(loaded).toHaveLength(0);
  });

  it("update modifies a memory", async () => {
    const store = createStore("/test/project");
    const mem = makeMemory({ id: "m_update_test", content: "original" });
    await store.add([mem]);
    await store.update("m_update_test", { content: "updated" });

    const loaded = await store.load("project");
    expect(loaded[0].content).toBe("updated");
  });

  it("search returns results sorted by strength", async () => {
    const store = createStore("/test/project");
    await store.add([
      makeMemory({
        content: "typescript is great",
        salience: { novelty: 0.2, relevance: 0.2, emotional: 0.2, predictive: 0.2 },
      }),
      makeMemory({
        content: "typescript with bun is fast",
        salience: { novelty: 0.9, relevance: 0.9, emotional: 0.9, predictive: 0.9 },
      }),
    ]);

    const results = await store.search("typescript");
    expect(results).toHaveLength(2);
    // Higher salience should come first
    expect(results[0].content).toBe("typescript with bun is fast");
  });

  it("searchByTag with OR logic", async () => {
    const store = createStore("/test/project");
    await store.add([
      makeMemory({ content: "mem1", tags: ["identity"] }),
      makeMemory({ content: "mem2", tags: ["technical"] }),
      makeMemory({ content: "mem3", tags: ["creative"] }),
    ]);

    const results = await store.searchByTag(["identity", "technical"]);
    expect(results).toHaveLength(2);
    const contents = results.map((r) => r.content);
    expect(contents).toContain("mem1");
    expect(contents).toContain("mem2");
  });

  it("cursor load/save round-trip", async () => {
    const store = createStore("/test/project");
    const cursor = { byteOffset: 12345, lastSessionId: "session-abc" };
    await store.saveCursor(cursor);

    const loaded = await store.loadCursor();
    expect(loaded).toEqual(cursor);
  });

  it("backup creates a file and manages max 5", async () => {
    const store = createStore("/test/project");
    await store.add([makeMemory({ content: "backup test" })]);

    const path = await store.backup();
    expect(path).toContain("memories-");

    // Create 6 backups, should keep only 5
    for (let i = 0; i < 6; i++) {
      await store.backup();
    }
    const { readdirSync } = await import("node:fs");
    const backups = readdirSync(join(tempDir, "backups")).filter((f) =>
      f.startsWith("memories-"),
    );
    expect(backups.length).toBeLessThanOrEqual(5);
  });
});
