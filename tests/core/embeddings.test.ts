import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  cosineSimilarity,
  isEmbeddingEnabled,
  embed,
  loadEmbeddingIndex,
  saveEmbeddingIndex,
  embedAndStore,
  removeFromIndex,
  vectorSearch,
} from "../../src/core/embeddings.js";
import { resetConfig } from "../../src/core/config.js";
import type { Memory } from "../../src/core/types.js";

let tempDir: string;

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    content: "test memory",
    scope: "project",
    memory_type: "episodic",
    salience: { novelty: 0.5, relevance: 0.5, emotional: 0.5, predictive: 0.5 },
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
  tempDir = mkdtempSync(join(tmpdir(), "engram-emb-test-"));
  process.env.ENGRAM_DATA_DIR = tempDir;
  resetConfig();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.ENGRAM_DATA_DIR;
  delete process.env.VOYAGE_API_KEY;
  resetConfig();
  vi.restoreAllMocks();
});

// --- cosineSimilarity ---

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const v = [1, 2, 3];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0);
  });

  it("returns 0 for zero-length vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("returns 0 when one vector is all zeros", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it("returns 0 for mismatched dimensions", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });
});

// --- isEmbeddingEnabled ---

describe("isEmbeddingEnabled", () => {
  it("returns false when VOYAGE_API_KEY not set", () => {
    delete process.env.VOYAGE_API_KEY;
    expect(isEmbeddingEnabled()).toBe(false);
  });

  it("returns true when VOYAGE_API_KEY is set", () => {
    process.env.VOYAGE_API_KEY = "test-key";
    expect(isEmbeddingEnabled()).toBe(true);
  });

  it("returns false when VOYAGE_API_KEY is empty string", () => {
    process.env.VOYAGE_API_KEY = "";
    expect(isEmbeddingEnabled()).toBe(false);
  });
});

// --- embed (Voyage API) ---

describe("embed", () => {
  it("returns empty array when no API key", async () => {
    delete process.env.VOYAGE_API_KEY;
    const result = await embed(["hello"]);
    expect(result).toEqual([]);
  });

  it("returns empty array for empty input", async () => {
    process.env.VOYAGE_API_KEY = "test-key";
    const result = await embed([]);
    expect(result).toEqual([]);
  });

  it("calls Voyage API with correct format", async () => {
    process.env.VOYAGE_API_KEY = "test-key";
    const mockResponse = {
      data: [{ embedding: [0.1, 0.2, 0.3] }],
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(mockResponse), { status: 200 }),
    );

    const result = await embed(["hello world"]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.voyageai.com/v1/embeddings");
    expect(opts?.method).toBe("POST");
    const body = JSON.parse(opts?.body as string);
    expect(body.input).toEqual(["hello world"]);
    expect(body.model).toBe("voyage-3-lite");
    expect(result).toEqual([[0.1, 0.2, 0.3]]);
  });

  it("returns empty array on non-200 response", async () => {
    process.env.VOYAGE_API_KEY = "test-key";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("error", { status: 500 }),
    );

    const result = await embed(["hello"]);
    expect(result).toEqual([]);
  });

  it("retries once on 429", async () => {
    process.env.VOYAGE_API_KEY = "test-key";
    const mockResponse = { data: [{ embedding: [0.1] }] };

    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), { status: 200 }),
      );

    const result = await embed(["hello"]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result).toEqual([[0.1]]);
  });

  it("does not retry more than once on 429", async () => {
    process.env.VOYAGE_API_KEY = "test-key";

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "0" },
      }),
    );

    const result = await embed(["hello"]);
    // First call + one retry = 2
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result).toEqual([]);
  });

  it("returns empty array on fetch error", async () => {
    process.env.VOYAGE_API_KEY = "test-key";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network error"));

    const result = await embed(["hello"]);
    expect(result).toEqual([]);
  });

  it("batches texts in groups of 128", async () => {
    process.env.VOYAGE_API_KEY = "test-key";
    // Create 200 texts
    const texts = Array.from({ length: 200 }, (_, i) => `text ${i}`);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, opts) => {
      const body = JSON.parse((opts as RequestInit).body as string);
      const embeddings = body.input.map((_: string, i: number) => ({
        embedding: [i * 0.01],
      }));
      return new Response(JSON.stringify({ data: embeddings }), { status: 200 });
    });

    const result = await embed(texts);
    // 200 texts → ceil(200/128) = 2 API calls
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(200);
  });
});

// --- Index I/O ---

describe("loadEmbeddingIndex", () => {
  it("returns empty object for missing file", () => {
    const index = loadEmbeddingIndex(join(tempDir, "nonexistent.json"));
    expect(index).toEqual({});
  });

  it("returns empty object for corrupt JSON", () => {
    const path = join(tempDir, "corrupt.json");
    const { writeFileSync } = require("node:fs");
    writeFileSync(path, "not json{{{");
    expect(loadEmbeddingIndex(path)).toEqual({});
  });

  it("returns empty object for array JSON (not an object)", () => {
    const path = join(tempDir, "array.json");
    const { writeFileSync } = require("node:fs");
    writeFileSync(path, "[1,2,3]");
    expect(loadEmbeddingIndex(path)).toEqual({});
  });

  it("round-trips through save/load", () => {
    const path = join(tempDir, "test-index.json");
    const index = { mem_1: [0.1, 0.2], mem_2: [0.3, 0.4] };
    saveEmbeddingIndex(path, index);
    const loaded = loadEmbeddingIndex(path);
    expect(loaded).toEqual(index);
  });

  it("creates parent directories on save", () => {
    const path = join(tempDir, "deep", "nested", "index.json");
    saveEmbeddingIndex(path, { mem_1: [0.1] });
    const loaded = loadEmbeddingIndex(path);
    expect(loaded).toEqual({ mem_1: [0.1] });
  });
});

// --- embedAndStore ---

describe("embedAndStore", () => {
  it("does nothing when embeddings disabled", async () => {
    delete process.env.VOYAGE_API_KEY;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const path = join(tempDir, "emb.json");

    await embedAndStore([makeMemory()], path);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("embeds memories and saves to index", async () => {
    process.env.VOYAGE_API_KEY = "test-key";
    const mem = makeMemory({ id: "m_test_1", content: "hello world" });
    const embPath = join(tempDir, "emb.json");

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ embedding: [0.5, 0.6] }] }), { status: 200 }),
    );

    await embedAndStore([mem], embPath);
    const index = loadEmbeddingIndex(embPath);
    expect(index["m_test_1"]).toEqual([0.5, 0.6]);
  });
});

// --- removeFromIndex ---

describe("removeFromIndex", () => {
  it("does nothing when index file missing", async () => {
    const path = join(tempDir, "nonexistent.json");
    // Should not throw
    await removeFromIndex(["m_1"], path);
  });

  it("removes entries from existing index", async () => {
    const path = join(tempDir, "emb.json");
    saveEmbeddingIndex(path, { m_1: [0.1], m_2: [0.2], m_3: [0.3] });

    await removeFromIndex(["m_1", "m_3"], path);
    const index = loadEmbeddingIndex(path);
    expect(index).toEqual({ m_2: [0.2] });
  });
});

// --- vectorSearch ---

describe("vectorSearch", () => {
  it("returns empty map when embeddings disabled", async () => {
    delete process.env.VOYAGE_API_KEY;
    const scores = await vectorSearch("test", [makeMemory()], "/g", "/p");
    expect(scores.size).toBe(0);
  });

  it("returns similarity scores for memories with embeddings", async () => {
    process.env.VOYAGE_API_KEY = "test-key";
    const mem1 = makeMemory({ id: "m_1", content: "pottery class", scope: "project" });
    const mem2 = makeMemory({ id: "m_2", content: "software testing", scope: "project" });

    const projectEmbPath = join(tempDir, "proj-emb.json");
    const globalEmbPath = join(tempDir, "glob-emb.json");

    // Pre-populate index: mem1 vector is similar to query, mem2 is not
    saveEmbeddingIndex(projectEmbPath, {
      m_1: [0.9, 0.1, 0.0],
      m_2: [0.0, 0.1, 0.9],
    });
    saveEmbeddingIndex(globalEmbPath, {});

    // Mock: query embedding is close to mem1's vector
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ embedding: [0.85, 0.15, 0.05] }] }), { status: 200 }),
    );

    const scores = await vectorSearch("hobby", [mem1, mem2], globalEmbPath, projectEmbPath);

    // mem1 should have high similarity, mem2 low (possibly filtered out by 0.3 threshold)
    expect(scores.has("m_1")).toBe(true);
    expect(scores.get("m_1")!).toBeGreaterThan(0.5);
  });

  it("lazy-embeds memories missing from index", async () => {
    process.env.VOYAGE_API_KEY = "test-key";
    const mem = makeMemory({ id: "m_lazy", content: "new memory", scope: "project" });

    const projectEmbPath = join(tempDir, "proj-emb.json");
    const globalEmbPath = join(tempDir, "glob-emb.json");
    saveEmbeddingIndex(projectEmbPath, {}); // Empty — mem not indexed yet
    saveEmbeddingIndex(globalEmbPath, {});

    let callCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      callCount++;
      // First call: query embedding. Second call: lazy embed of missing memory.
      return new Response(
        JSON.stringify({ data: [{ embedding: [0.5, 0.5, 0.5] }] }),
        { status: 200 },
      );
    });

    await vectorSearch("query", [mem], globalEmbPath, projectEmbPath);

    // Should have called API for query + lazy embed
    expect(callCount).toBeGreaterThanOrEqual(2);

    // Verify the lazy-embedded vector was persisted
    const index = loadEmbeddingIndex(projectEmbPath);
    expect(index["m_lazy"]).toBeDefined();
  });
});
