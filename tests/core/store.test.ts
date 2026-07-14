import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore, tokenize, tokenOverlap, tokensMatch } from "../../src/core/store.js";
import type { Memory } from "../../src/core/types.js";
import { generateId } from "../../src/core/types.js";
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
  tempDir = mkdtempSync(join(tmpdir(), "engram-test-"));
  process.env.ENGRAM_DATA_DIR = tempDir;
  delete process.env.VOYAGE_API_KEY;
  resetConfig();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.ENGRAM_DATA_DIR;
  delete process.env.VOYAGE_API_KEY;
  resetConfig();
  vi.restoreAllMocks();
});

describe("tokenize", () => {
  it("splits text into lowercase tokens", () => {
    expect(tokenize("Hello World")).toEqual(["hello", "world"]);
  });

  it("strips possessives", () => {
    expect(tokenize("Mike's kids")).toEqual(["mike", "kids"]);
  });

  it("drops single-char tokens", () => {
    expect(tokenize("I am a person")).toEqual(["am", "person"]);
  });

  it("handles punctuation and special chars", () => {
    expect(tokenize("bun-test, vitest!")).toEqual(["bun", "test", "vitest"]);
  });
});

describe("tokenOverlap", () => {
  it("returns 1.0 for perfect match", () => {
    expect(tokenOverlap(["mike", "kids"], ["mike", "kids", "play"])).toBe(1.0);
  });

  it("returns 0.5 for half match", () => {
    expect(tokenOverlap(["mike", "dogs"], ["mike", "kids"])).toBe(0.5);
  });

  it("returns 0 for no match", () => {
    expect(tokenOverlap(["xyz", "abc"], ["mike", "kids"])).toBe(0);
  });

  it("matches substrings bidirectionally", () => {
    // "type" is substring of "typescript"
    expect(tokenOverlap(["type"], ["typescript", "project"])).toBe(1.0);
  });
});

describe("tokensMatch length guard (2026-07-14 river-trip regression)", () => {
  it("matches real stems in either direction", () => {
    expect(tokensMatch("raft", "rafting")).toBe(true);
    expect(tokensMatch("rafting", "raft")).toBe(true);
    expect(tokensMatch("typescript", "type")).toBe(true);
  });

  it("rejects short-token shrapnel inside long words", () => {
    // Pre-fix, every English memory scored ~0.5 against any multi-word query
    // via exactly these pairs — the honest relevance signal drowned in noise
    expect(tokensMatch("flathead", "the")).toBe(false);
    expect(tokensMatch("rafting", "in")).toBe(false);
    expect(tokensMatch("north", "or")).toBe(false);
    expect(tokensMatch("north", "no")).toBe(false);
    expect(tokensMatch("katie", "at")).toBe(false);
    expect(tokensMatch("fork", "for")).toBe(false);
  });

  it("exact short tokens still match", () => {
    expect(tokensMatch("the", "the")).toBe(true);
    expect(tokensMatch("api", "api")).toBe(true);
  });

  it("an unrelated memory no longer half-matches an entity-heavy query", () => {
    const query = tokenize("Mike rafting trip North Fork Flathead river Katie family");
    const generic = tokenize(
      "Mike's test for whether memory actually works: not whether it recites facts, but whether something shifts in the engagement",
    );
    expect(tokenOverlap(query, generic)).toBeLessThan(0.2); // was ~0.5 pre-fix
  });
});

describe("search ranking — cued retrieval reaches weak memories", () => {
  it("a directly-relevant low-strength memory outranks fresh strength-1.0 generics", async () => {
    const store = createStore("/test/project");
    // The 2026-07-14 miss, miniaturized: an on-point memory with merge-slashed
    // salience and six days of decay...
    const trip = makeMemory({
      content: "Mike left for a rafting trip on the North Fork of the Flathead with Katie's brother",
      salience: { novelty: 0.3, relevance: 0.5, emotional: 0.4, predictive: 0.3 },
      created_at: new Date(Date.now() - 6 * 86_400_000).toISOString(),
    });
    // ...versus a wall of fresh, maximally-strong memories about the same
    // person whose only honest token match is the name
    const generics = Array.from({ length: 8 }, (_, i) =>
      makeMemory({
        content: `Mike's test number ${i} for whether memory actually works: not whether it recites facts, but whether something shifts in the engagement`,
        salience: { novelty: 1, relevance: 1, emotional: 1, predictive: 1 },
        access_count: 5,
      }),
    );
    await store.add([trip, ...generics]);

    const results = await store.search("Mike rafting trip North Fork Flathead river Katie family", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("rafting trip");
  });
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

  it("search falls back to token matching when no substring match", async () => {
    const store = createStore("/test/project");
    await store.add([
      makeMemory({ content: "Ada and Grace are Sam's kids", tags: ["relationship"] }),
      makeMemory({ content: "project uses vitest for testing" }),
      makeMemory({ content: "bun is the preferred runtime" }),
    ]);

    // "Sam's children" has no exact substring match, but token overlap on
    // "Sam" should still surface the kids memory
    const results = await store.search("Sam's children");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].content).toContain("Ada");
  });

  it("search matches against tags in token mode", async () => {
    const store = createStore("/test/project");
    await store.add([
      makeMemory({ content: "loves hiking in mountains", tags: ["personal", "preference"] }),
      makeMemory({ content: "uses strict TypeScript", tags: ["technical"] }),
    ]);

    // "personal" won't substring match content, but should match tag
    const results = await store.search("personal");
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain("hiking");
  });

  it("search prefers exact substring matches over token matches", async () => {
    const store = createStore("/test/project");
    await store.add([
      makeMemory({ content: "Sam lives in Oregon" }),
      makeMemory({ content: "the sampler broke" }), // "sampler" contains "sam"
    ]);

    // "Sam" exact substring match should rank the true match first
    const results = await store.search("Sam lives");
    expect(results[0].content).toContain("Sam lives");
  });

  it("getTemporalSiblings returns memories from same session", async () => {
    const store = createStore("/test/project");
    const sessionId = "session-123";
    const mem1 = makeMemory({ id: "ts_1", content: "first in session", source_session: sessionId });
    const mem2 = makeMemory({ id: "ts_2", content: "second in session", source_session: sessionId });
    const mem3 = makeMemory({ id: "ts_3", content: "different session", source_session: "other" });
    await store.add([mem1, mem2, mem3]);

    const siblings = await store.getTemporalSiblings(sessionId, "ts_1");
    expect(siblings).toHaveLength(1);
    expect(siblings[0].id).toBe("ts_2");
  });

  it("getTemporalSiblings excludes synthetic sessions", async () => {
    const store = createStore("/test/project");
    const mem1 = makeMemory({ id: "mc_1", source_session: "mcp-store" });
    const mem2 = makeMemory({ id: "mc_2", source_session: "mcp-store" });
    await store.add([mem1, mem2]);

    const siblings = await store.getTemporalSiblings("mcp-store", "mc_1");
    expect(siblings).toHaveLength(0);
  });

  it("getTemporalSiblings respects limit", async () => {
    const store = createStore("/test/project");
    const session = "session-limit";
    await store.add([
      makeMemory({ id: "lim_1", source_session: session }),
      makeMemory({ id: "lim_2", source_session: session }),
      makeMemory({ id: "lim_3", source_session: session }),
      makeMemory({ id: "lim_4", source_session: session }),
    ]);

    const siblings = await store.getTemporalSiblings(session, "lim_1", 2);
    expect(siblings).toHaveLength(2);
  });

  it("loadAll cache returns same result within TTL", async () => {
    const store = createStore("/test/project");
    await store.add([makeMemory({ content: "cached" })]);

    const first = await store.loadAll();
    const second = await store.loadAll();
    // Same reference means cache hit
    expect(first).toBe(second);
  });

  it("loadAll cache invalidated after mutation", async () => {
    const store = createStore("/test/project");
    await store.add([makeMemory({ content: "before" })]);

    const first = await store.loadAll();
    expect(first).toHaveLength(1);

    await store.add([makeMemory({ content: "after" })]);
    const second = await store.loadAll();
    expect(second).toHaveLength(2);
    // Different reference means cache was invalidated
    expect(first).not.toBe(second);
  });

  it("getRecentAndStrong returns current session memories", async () => {
    const store = createStore("/test/project");
    const oldDate = new Date(Date.now() - 7 * 86400_000).toISOString(); // 7 days ago
    await store.add([
      makeMemory({ content: "current session", source_session: "sess-1", created_at: oldDate }),
      makeMemory({ content: "other session", source_session: "sess-2", created_at: oldDate }),
    ]);

    const result = await store.getRecentAndStrong("sess-1");
    const contents = result.map((m) => m.content);
    expect(contents).toContain("current session");
  });

  it("getRecentAndStrong returns recent memories within window", async () => {
    const store = createStore("/test/project");
    const recentDate = new Date(Date.now() - 12 * 3600_000).toISOString(); // 12 hours ago
    const oldDate = new Date(Date.now() - 5 * 86400_000).toISOString(); // 5 days ago
    await store.add([
      makeMemory({ content: "recent", source_session: "other", created_at: recentDate }),
      makeMemory({
        content: "old but strong",
        source_session: "other",
        created_at: oldDate,
        salience: { novelty: 0.9, relevance: 0.9, emotional: 0.9, predictive: 0.9 },
      }),
    ]);

    const result = await store.getRecentAndStrong("sess-X", { topStrongest: 0 });
    // Should include recent but not old (with topStrongest=0, no strength-based inclusion)
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("recent");
  });

  it("getRecentAndStrong caps at maxTotal", async () => {
    const store = createStore("/test/project");
    const mems = Array.from({ length: 10 }, (_, i) =>
      makeMemory({ content: `mem-${i}`, source_session: "sess-1" }),
    );
    await store.add(mems);

    const result = await store.getRecentAndStrong("sess-1", { maxTotal: 5 });
    expect(result).toHaveLength(5);
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

  it("search boosts recent memories over older ones with same salience", async () => {
    const store = createStore("/test/project");
    const oldDate = new Date(Date.now() - 7 * 86_400_000).toISOString(); // 7 days ago
    const recentDate = new Date(Date.now() - 60_000).toISOString(); // 1 minute ago
    await store.add([
      makeMemory({
        content: "typescript project setup details",
        created_at: oldDate,
        salience: { novelty: 0.8, relevance: 0.8, emotional: 0.8, predictive: 0.8 },
      }),
      makeMemory({
        content: "typescript migration to new version",
        created_at: recentDate,
        salience: { novelty: 0.8, relevance: 0.8, emotional: 0.8, predictive: 0.8 },
      }),
    ]);

    const results = await store.search("typescript");
    expect(results).toHaveLength(2);
    // Recent memory should rank first due to recency boost
    expect(results[0].content).toContain("migration");
  });

  it("recency boost fades — 24h old memory gets minimal boost", async () => {
    const store = createStore("/test/project");
    const dayOld = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const weekOld = new Date(Date.now() - 7 * 86_400_000).toISOString();
    await store.add([
      makeMemory({
        content: "typescript older memory",
        created_at: weekOld,
        salience: { novelty: 0.9, relevance: 0.9, emotional: 0.9, predictive: 0.9 },
      }),
      makeMemory({
        content: "typescript newer memory",
        created_at: dayOld,
        salience: { novelty: 0.7, relevance: 0.7, emotional: 0.7, predictive: 0.7 },
      }),
    ]);

    const results = await store.search("typescript");
    expect(results).toHaveLength(2);
    // Higher salience should still win when both are old enough that recency boost is minimal
    expect(results[0].content).toContain("older");
  });

  describe("checkDuplicates", () => {
    it("detects duplicate via token overlap", async () => {
      const store = createStore("/test/project");
      await store.add([
        makeMemory({ content: "Mike prefers bun over npm for running scripts" }),
      ]);

      const dupes = await store.checkDuplicates([
        "Mike prefers bun over npm for running scripts",
        "TypeScript is the language of choice",
      ]);
      expect(dupes.has(0)).toBe(true); // first is duplicate
      expect(dupes.has(1)).toBe(false); // second is unique
    });

    it("returns empty set for empty input", async () => {
      const store = createStore("/test/project");
      const dupes = await store.checkDuplicates([]);
      expect(dupes.size).toBe(0);
    });

    it("returns empty set when no existing memories", async () => {
      const store = createStore("/test/project");
      const dupes = await store.checkDuplicates(["brand new memory content"]);
      expect(dupes.size).toBe(0);
    });

    it("does not flag dissimilar content as duplicate", async () => {
      const store = createStore("/test/project");
      await store.add([
        makeMemory({ content: "Mike prefers bun over npm" }),
      ]);

      const dupes = await store.checkDuplicates([
        "The weather in Oregon is beautiful today",
      ]);
      expect(dupes.size).toBe(0);
    });

    it("marks within-batch duplicates, keeping the first occurrence", async () => {
      // Chunked extraction can emit the same fact from two chunks of one arc —
      // nothing in the store yet, the duplicate is internal to the batch.
      const store = createStore("/test/project");

      const dupes = await store.checkDuplicates([
        "Mike prefers bun over npm for running scripts",
        "TypeScript is the language of choice",
        "Mike prefers bun over npm for running scripts",
      ]);
      expect(dupes.has(0)).toBe(false); // first occurrence kept
      expect(dupes.has(1)).toBe(false);
      expect(dupes.has(2)).toBe(true); // within-batch duplicate marked
    });
  });

  describe("briefing cache", () => {
    it("save and load round-trip", async () => {
      const store = createStore("/test/project");
      await store.saveBriefingCache("Test briefing content", 42);

      const cached = await store.loadBriefingCache();
      expect(cached).not.toBeNull();
      expect(cached!.briefing).toBe("Test briefing content");
      expect(cached!.memoryCount).toBe(42);
      expect(cached!.generatedAt).toBeTruthy();
    });

    it("returns null when no cache exists", async () => {
      const store = createStore("/test/project");
      const cached = await store.loadBriefingCache();
      expect(cached).toBeNull();
    });

    it("overwrites previous cache", async () => {
      const store = createStore("/test/project");
      await store.saveBriefingCache("First briefing", 10);
      await store.saveBriefingCache("Second briefing", 20);

      const cached = await store.loadBriefingCache();
      expect(cached!.briefing).toBe("Second briefing");
      expect(cached!.memoryCount).toBe(20);
    });
  });

  describe("hybrid search (embeddings)", () => {
    it("falls back to token-only search when VOYAGE_API_KEY not set", async () => {
      delete process.env.VOYAGE_API_KEY;
      const store = createStore("/test/project");
      await store.add([
        makeMemory({ content: "Ada and Grace are Sam's kids", tags: ["relationship"] }),
      ]);

      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const results = await store.search("Mike's kids");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("existing search tests work with embeddings disabled", async () => {
      delete process.env.VOYAGE_API_KEY;
      const store = createStore("/test/project");
      await store.add([
        makeMemory({ content: "typescript is great" }),
        makeMemory({ content: "bun is the preferred runtime" }),
      ]);

      const results = await store.search("typescript");
      expect(results).toHaveLength(1);
      expect(results[0].content).toContain("typescript");
    });

    it("hybrid search includes vector-only matches", async () => {
      process.env.VOYAGE_API_KEY = "test-key";

      // Mock the Voyage API for both the add() embedAndStore calls and search vectorSearch call
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, opts) => {
        const body = JSON.parse((opts as RequestInit).body as string);
        const embeddings = body.input.map((text: string) => {
          // "pottery at a local studio" → vector similar to hobby queries
          if (text.includes("pottery")) return { embedding: [0.9, 0.1, 0.0] };
          // "software testing" → orthogonal
          if (text.includes("software")) return { embedding: [0.0, 0.1, 0.9] };
          // "hobby" query → similar to pottery
          if (text.includes("hobby")) return { embedding: [0.85, 0.15, 0.05] };
          return { embedding: [0.33, 0.33, 0.33] };
        });
        return new Response(JSON.stringify({ data: embeddings }), { status: 200 });
      });

      const store = createStore("/test/project");
      await store.add([
        makeMemory({ content: "Angela started pottery at a local studio", tags: ["personal"] }),
        makeMemory({ content: "software testing with vitest", tags: ["technical"] }),
      ]);

      // "hobby" has zero token overlap with "pottery" but high vector similarity
      const results = await store.search("What hobby did Angela take up?");
      expect(results.length).toBeGreaterThanOrEqual(1);
      // Pottery memory should be found via vector similarity
      expect(results.some((r) => r.content.includes("pottery"))).toBe(true);
    });

    it("search degrades gracefully when vector search fails", async () => {
      process.env.VOYAGE_API_KEY = "test-key";

      // Fail on all API calls after initial add
      let callCount = 0;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, opts) => {
        callCount++;
        // Let the add() embedAndStore calls succeed
        if (callCount <= 2) {
          const body = JSON.parse((opts as RequestInit).body as string);
          const embeddings = body.input.map(() => ({ embedding: [0.5] }));
          return new Response(JSON.stringify({ data: embeddings }), { status: 200 });
        }
        // Fail during search
        throw new Error("network error");
      });

      const store = createStore("/test/project");
      await store.add([
        makeMemory({ content: "bun is the preferred runtime", tags: ["technical"] }),
      ]);

      // Should still find results via token overlap despite vector search failure
      const results = await store.search("bun runtime");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].content).toContain("bun");
    });
  });
});
