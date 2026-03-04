import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { loadConfig } from "./config.js";
import { log } from "./logger.js";
import type { Memory } from "./types.js";

// --- Types ---

/** Map of memory ID → embedding vector */
export type EmbeddingIndex = Record<string, number[]>;

// --- Config check ---

/** True iff VOYAGE_API_KEY is set AND config.embeddingsEnabled !== false */
export function isEmbeddingEnabled(): boolean {
  return !!process.env.VOYAGE_API_KEY && loadConfig().embeddingsEnabled !== false;
}

// --- Math ---

/** Cosine similarity between two vectors. Returns 0 for zero-length vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// --- Voyage API ---

const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings";
const MAX_BATCH_SIZE = 128;

/** Embed texts via Voyage API. Returns array of vectors (one per text), or [] on failure. */
export async function embed(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey || texts.length === 0) return [];

  const config = loadConfig();
  const model = config.embeddingModel;
  const results: number[][] = [];

  // Batch into chunks of MAX_BATCH_SIZE
  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_BATCH_SIZE);
    const vectors = await callVoyageAPI(apiKey, model, batch);
    if (vectors.length === 0) return []; // Fail entire call on batch failure
    results.push(...vectors);
  }

  return results;
}

async function callVoyageAPI(
  apiKey: string,
  model: string,
  input: string[],
  retryCount = 0,
): Promise<number[][]> {
  try {
    const response = await fetch(VOYAGE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ input, model }),
    });

    if (response.status === 429 && retryCount === 0) {
      // Retry once on rate limit
      const retryAfter = parseInt(response.headers.get("retry-after") || "1", 10);
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      return callVoyageAPI(apiKey, model, input, 1);
    }

    if (!response.ok) {
      log("warn", `Voyage API error: ${response.status} ${response.statusText}`);
      return [];
    }

    const body = await response.json() as { data: Array<{ embedding: number[] }> };
    return body.data.map((d) => d.embedding);
  } catch (err) {
    log("warn", `Voyage API call failed: ${err}`);
    return [];
  }
}

// --- Index I/O ---

/** Load embedding index from JSON file. Returns {} on missing/corrupt file. */
export function loadEmbeddingIndex(path: string): EmbeddingIndex {
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as EmbeddingIndex;
    }
    return {};
  } catch {
    return {};
  }
}

/** Save embedding index to JSON file (creates parent dirs if needed). */
export function saveEmbeddingIndex(path: string, index: EmbeddingIndex): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(index), "utf-8");
}

// --- Store integration ---

/** Embed memories and merge into existing index. */
export async function embedAndStore(memories: Memory[], embeddingsPath: string): Promise<void> {
  if (!isEmbeddingEnabled() || memories.length === 0) return;

  const texts = memories.map((m) => m.content);
  const vectors = await embed(texts);
  if (vectors.length !== texts.length) return; // API failure, skip silently

  let release: (() => Promise<void>) | undefined;
  try {
    // Ensure file exists for lockfile
    try { readFileSync(embeddingsPath); } catch { saveEmbeddingIndex(embeddingsPath, {}); }

    release = await lockfile.lock(embeddingsPath, {
      stale: 5000,
      retries: { retries: 3, minTimeout: 100, maxTimeout: 1000 },
    });
    const index = loadEmbeddingIndex(embeddingsPath);
    for (let i = 0; i < memories.length; i++) {
      index[memories[i].id] = vectors[i];
    }
    saveEmbeddingIndex(embeddingsPath, index);
  } catch (err) {
    log("warn", `embedAndStore failed: ${err}`);
  } finally {
    if (release) await release();
  }
}

/** Remove memory IDs from embedding index. */
export async function removeFromIndex(ids: string[], embeddingsPath: string): Promise<void> {
  if (ids.length === 0) return;

  let release: (() => Promise<void>) | undefined;
  try {
    try { readFileSync(embeddingsPath); } catch { return; } // No index file, nothing to remove

    release = await lockfile.lock(embeddingsPath, {
      stale: 5000,
      retries: { retries: 3, minTimeout: 100, maxTimeout: 1000 },
    });
    const index = loadEmbeddingIndex(embeddingsPath);
    let changed = false;
    for (const id of ids) {
      if (id in index) {
        delete index[id];
        changed = true;
      }
    }
    if (changed) saveEmbeddingIndex(embeddingsPath, index);
  } catch (err) {
    log("warn", `removeFromIndex failed: ${err}`);
  } finally {
    if (release) await release();
  }
}

/** Vector search: embed query, score all memories, lazy-embed missing ones. */
export async function vectorSearch(
  query: string,
  allMemories: Memory[],
  globalEmbPath: string,
  projectEmbPath: string,
): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  if (!isEmbeddingEnabled() || allMemories.length === 0) return scores;

  // Embed the query
  const queryVectors = await embed([query]);
  if (queryVectors.length === 0) return scores;
  const queryVec = queryVectors[0];

  // Load both indexes
  const globalIndex = loadEmbeddingIndex(globalEmbPath);
  const projectIndex = loadEmbeddingIndex(projectEmbPath);

  // Find memories missing from index for lazy migration
  const missingGlobal: Memory[] = [];
  const missingProject: Memory[] = [];
  for (const m of allMemories) {
    const index = m.scope === "global" ? globalIndex : projectIndex;
    if (!(m.id in index)) {
      if (m.scope === "global") missingGlobal.push(m);
      else missingProject.push(m);
    }
  }

  // Lazy-embed missing memories
  if (missingGlobal.length > 0) {
    const vecs = await embed(missingGlobal.map((m) => m.content));
    if (vecs.length === missingGlobal.length) {
      for (let i = 0; i < missingGlobal.length; i++) {
        globalIndex[missingGlobal[i].id] = vecs[i];
      }
      saveEmbeddingIndex(globalEmbPath, globalIndex);
    }
  }
  if (missingProject.length > 0) {
    const vecs = await embed(missingProject.map((m) => m.content));
    if (vecs.length === missingProject.length) {
      for (let i = 0; i < missingProject.length; i++) {
        projectIndex[missingProject[i].id] = vecs[i];
      }
      saveEmbeddingIndex(projectEmbPath, projectIndex);
    }
  }

  // Compute similarities
  for (const m of allMemories) {
    const index = m.scope === "global" ? globalIndex : projectIndex;
    const vec = index[m.id];
    if (!vec) continue;
    const sim = cosineSimilarity(queryVec, vec);
    if (sim > 0.3) { // Filter noise
      scores.set(m.id, sim);
    }
  }

  return scores;
}
