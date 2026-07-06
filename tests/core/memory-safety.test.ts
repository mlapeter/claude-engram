import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createStore, type MemoryStore } from "../../src/core/store.js";
import { generateId } from "../../src/core/types.js";
import type { Memory } from "../../src/core/types.js";
import { resetConfig } from "../../src/core/config.js";
import { applyInterference } from "../../src/core/interference.js";

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
  },
}));

import { applyConsolidation, runConsolidation } from "../../src/core/consolidation.js";
import { commitMemorySnapshot } from "../../src/core/snapshot.js";
import { generateBriefing } from "../../src/core/briefing.js";

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

const SALIENCE = { novelty: 0.5, relevance: 0.5, emotional: 0.5, predictive: 0.5 };
const emptyResult = () => ({ merge: [], generalize: [], prune_ids: [], notes: "" });
const daysAgo = (d: number) => new Date(Date.now() - d * 86400000).toISOString();

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "engram-safety-test-"));
  process.env.ENGRAM_DATA_DIR = tempDir;
  delete process.env.VOYAGE_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  // git snapshots off by default in these tests (dedicated snapshot tests opt in)
  writeFileSync(join(tempDir, "config.json"), JSON.stringify({ memoryHistory: false }));
  resetConfig();
  mockCreate.mockReset();
  store = createStore(process.cwd());
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.ENGRAM_DATA_DIR;
  resetConfig();
});

describe("never-destroy: merge sources are archived with lineage", () => {
  it("archives merge sources with merged_into instead of deleting them", async () => {
    const m1 = makeMemory({ id: "m_1_aaaa", content: "source one" });
    const m2 = makeMemory({ id: "m_2_bbbb", content: "source two" });
    await store.add([m1, m2]);

    await applyConsolidation(store, [m1, m2], {
      ...emptyResult(),
      merge: [{
        ids: ["m_1_aaaa", "m_2_bbbb"],
        merged: { content: "merged result", salience: SALIENCE, tags: ["pattern"] },
      }],
    }, 0, 0);

    const active = await store.loadAll();
    const merged = active.find((m) => m.consolidated)!;
    expect(active).toHaveLength(1);

    const archive = await store.loadArchive("project");
    expect(archive.map((m) => m.id).sort()).toEqual(["m_1_aaaa", "m_2_bbbb"]);
    for (const a of archive) {
      expect(a.merged_into).toBe(merged.id);
      expect(a.archived).toBe(true);
    }
    // original verbatim content preserved
    expect(archive.find((m) => m.id === "m_1_aaaa")!.content).toBe("source one");
  });
});

describe("protected (sacred-verbatim) memories", () => {
  it("a protected source is never merged away — merge with too few remaining sources is skipped", async () => {
    const p = makeMemory({ id: "m_1_prot", content: "sacred words", protected: true });
    const n = makeMemory({ id: "m_2_norm", content: "normal memory" });
    await store.add([p, n]);

    const result = await applyConsolidation(store, [p, n], {
      ...emptyResult(),
      merge: [{
        ids: ["m_1_prot", "m_2_norm"],
        merged: { content: "should not exist", salience: SALIENCE, tags: ["pattern"] },
      }],
    }, 0, 0);

    expect(result.mergeCount).toBe(0);
    const active = await store.loadAll();
    expect(active.map((m) => m.id).sort()).toEqual(["m_1_prot", "m_2_norm"]);
    expect(active.find((m) => m.id === "m_1_prot")!.content).toBe("sacred words");
  });

  it("merges proceed without the protected member when enough sources remain", async () => {
    const p = makeMemory({ id: "m_1_prot", protected: true });
    const a = makeMemory({ id: "m_2_aaaa" });
    const b = makeMemory({ id: "m_3_bbbb" });
    await store.add([p, a, b]);

    const result = await applyConsolidation(store, [p, a, b], {
      ...emptyResult(),
      merge: [{
        ids: ["m_1_prot", "m_2_aaaa", "m_3_bbbb"],
        merged: { content: "merged", salience: SALIENCE, tags: ["pattern"] },
      }],
    }, 0, 0);

    expect(result.mergeCount).toBe(1);
    const active = await store.loadAll();
    expect(active.some((m) => m.id === "m_1_prot")).toBe(true); // survived
    expect(active.some((m) => m.id === "m_2_aaaa")).toBe(false); // merged away (archived)
  });

  it("protected memories are never pruned", async () => {
    const p = makeMemory({ id: "m_1_prot", protected: true });
    await store.add([p]);

    const result = await applyConsolidation(store, [p], {
      ...emptyResult(),
      prune_ids: ["m_1_prot"],
    }, 0, 0);

    expect(result.pruneCount).toBe(0);
    expect((await store.loadAll()).some((m) => m.id === "m_1_prot")).toBe(true);
  });

  it("protected memories are never weakened by interference", async () => {
    const old = makeMemory({ id: "m_1_prot", protected: true, salience: { novelty: 0.9, relevance: 0.9, emotional: 0.9, predictive: 0.9 } });
    await store.add([old]);
    const newer = makeMemory({ id: "m_2_new", updated_from: "m_1_prot" });

    const weakened = await applyInterference([newer], [old], store);

    expect(weakened).toBe(0);
    const after = (await store.loadAll()).find((m) => m.id === "m_1_prot")!;
    expect(after.salience.emotional).toBe(0.9);
  });
});

describe("archiveCopies", () => {
  it("appends copies to the right scope's archive without touching the active store", async () => {
    const g = makeMemory({ id: "m_1_glob", scope: "global", content: "global original" });
    await store.add([g]);

    const copy = { ...g, id: "m_1_copy", gist_of: g.id };
    const count = await store.archiveCopies([copy]);

    expect(count).toBe(1);
    expect((await store.loadAll()).map((m) => m.id)).toEqual(["m_1_glob"]); // active untouched
    const archive = await store.loadArchive("global");
    expect(archive).toHaveLength(1);
    expect(archive[0].id).toBe("m_1_copy");
    expect(archive[0].gist_of).toBe("m_1_glob");
    expect(archive[0].archived).toBe(true);
  });
});

describe("gist promotion — sacred verbatim + never-destroy", () => {
  it("archives verbatim originals, compresses only the mundane, and exempts emotional/protected", async () => {
    const mundane = makeMemory({ id: "m_1_mund", content: "a long mundane episodic memory with plenty of detail", created_at: daysAgo(10) });
    const sacred = makeMemory({ id: "m_2_emo", content: "emotionally heavy memory", created_at: daysAgo(10), salience: { novelty: 0.5, relevance: 0.5, emotional: 0.9, predictive: 0.5 } });
    const shielded = makeMemory({ id: "m_3_prot", content: "explicitly protected memory", created_at: daysAgo(10), protected: true });
    await store.add([mundane, sacred, shielded]);

    mockCreate.mockImplementation(async (req: { system?: string }) => {
      if ((req.system ?? "").includes("semantic gist")) {
        // promotion call — verify exempt ids were never offered
        const payload = JSON.stringify(req);
        expect(payload).toContain("m_1_mund");
        expect(payload).not.toContain("m_2_emo");
        expect(payload).not.toContain("m_3_prot");
        return { content: [{ type: "text", text: JSON.stringify({ items: [{ id: "m_1_mund", gist: "the gist" }] }) }] };
      }
      // consolidation call — nothing to do
      return { content: [{ type: "text", text: JSON.stringify(emptyResult()) }] };
    });

    const result = await runConsolidation(store);
    expect(result.promotionCount).toBe(1);

    const active = await store.loadAll();
    const gisted = active.find((m) => m.id === "m_1_mund")!;
    expect(gisted.content).toBe("the gist");
    expect(gisted.memory_type).toBe("semantic");
    expect(active.find((m) => m.id === "m_2_emo")!.content).toBe("emotionally heavy memory");
    expect(active.find((m) => m.id === "m_3_prot")!.memory_type).toBe("episodic");

    // verbatim original preserved in the archive with lineage
    const archive = await store.loadArchive("project");
    const original = archive.find((m) => m.gist_of === "m_1_mund")!;
    expect(original).toBeTruthy();
    expect(original.content).toBe("a long mundane episodic memory with plenty of detail");
  });

  it("ignores hallucinated ids in the gist response", async () => {
    const mundane = makeMemory({ id: "m_1_mund", content: "real memory", created_at: daysAgo(10) });
    await store.add([mundane]);

    mockCreate.mockImplementation(async (req: { system?: string }) => {
      if ((req.system ?? "").includes("semantic gist")) {
        return { content: [{ type: "text", text: JSON.stringify({ items: [
          { id: "m_1_mund", gist: "the gist" },
          { id: "m_9_fake", gist: "hallucinated" },
        ] }) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(emptyResult()) }] };
    });

    const result = await runConsolidation(store);
    expect(result.promotionCount).toBe(1);
  });
});

describe("memory history — git snapshots", () => {
  const hasGit = spawnSync("git", ["--version"]).status === 0;

  it.skipIf(!hasGit)("initializes the repo and commits, then reports no-change correctly", async () => {
    writeFileSync(join(tempDir, "config.json"), JSON.stringify({ memoryHistory: true }));
    resetConfig();
    await store.add([makeMemory({ content: "first memory" })]);

    expect(commitMemorySnapshot("test snapshot")).toBe(true);
    expect(existsSync(join(tempDir, ".git"))).toBe(true);
    expect(existsSync(join(tempDir, ".gitignore"))).toBe(true);

    // nothing changed → no commit
    expect(commitMemorySnapshot("empty snapshot")).toBe(false);

    // a change → a new commit
    await store.add([makeMemory({ content: "second memory" })]);
    expect(commitMemorySnapshot("second snapshot")).toBe(true);

    const logOut = spawnSync("git", ["log", "--oneline"], { cwd: tempDir, encoding: "utf-8" }).stdout;
    expect(logOut.trim().split("\n")).toHaveLength(2);
  });

  it.skipIf(!hasGit)("respects the ignore list — secrets and churn never enter history", async () => {
    writeFileSync(join(tempDir, "config.json"), JSON.stringify({ memoryHistory: true }));
    resetConfig();
    writeFileSync(join(tempDir, "env"), "ANTHROPIC_API_KEY=secret");
    writeFileSync(join(tempDir, "engram.log"), "log line");
    await store.add([makeMemory()]);

    commitMemorySnapshot("snapshot");

    const tracked = spawnSync("git", ["ls-files"], { cwd: tempDir, encoding: "utf-8" }).stdout;
    expect(tracked).not.toContain("env");
    expect(tracked).not.toContain("engram.log");
    expect(tracked).toContain("memories.json");
  });

  it("is a no-op when memoryHistory is disabled", async () => {
    // beforeEach config already sets memoryHistory: false
    await store.add([makeMemory()]);
    expect(commitMemorySnapshot("disabled")).toBe(false);
    expect(existsSync(join(tempDir, ".git"))).toBe(false);
  });
});

describe("briefing — reserved relational slots", () => {
  it("weak relational memories displace the weakest technical picks", async () => {
    writeFileSync(join(tempDir, "config.json"), JSON.stringify({ memoryHistory: false, briefingMaxMemories: 20 }));
    resetConfig();
    mockCreate.mockRejectedValue(new Error("no api in tests")); // → fallback renders the SELECTED set

    const technical = Array.from({ length: 30 }, (_, i) => makeMemory({
      content: `technical fact number ${i}`,
      created_at: daysAgo(2),
      access_count: 5, // strong
      salience: { novelty: 0.9, relevance: 0.9, emotional: 0.1, predictive: 0.9 },
    }));
    const relational = Array.from({ length: 5 }, (_, i) => makeMemory({
      content: `RELATIONAL-MARKER-${i} something tender`,
      tags: ["relationship"],
      created_at: daysAgo(40),
      access_count: 0, // weak
      salience: { novelty: 0.2, relevance: 0.2, emotional: 0.4, predictive: 0.2 },
    }));

    const briefing = await generateBriefing([...technical, ...relational]);

    for (let i = 0; i < 5; i++) {
      expect(briefing).toContain(`RELATIONAL-MARKER-${i}`);
    }
  });
});
