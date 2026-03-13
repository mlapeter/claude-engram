/**
 * Reconciliation engine — compares v1 and v4 memory sets,
 * produces a plan that the user reviews before applying.
 */

import { v1ToV4 } from "./schema.js";
import type { V1Memory } from "./schema.js";
import type { Memory, Salience } from "../core/types.js";
import { embed, cosineSimilarity, isEmbeddingEnabled } from "../core/embeddings.js";
import { log } from "../core/logger.js";

// --- Types ---

export interface SimilarPair {
  v1: V1Memory;
  v4: Memory;
  v1AsV4: Memory; // v1 converted to v4 format for display
  similarity: number;
  /** Pre-computed merge suggestion: newer content, max salience, union tags */
  suggestedMerge: Memory;
}

export interface DuplicatePair {
  v1: V1Memory;
  v4: Memory;
  similarity: number;
}

export interface ReconciliationPlan {
  /** v1 memories with no match in v4 — will be added to v4 */
  newFromV1: Array<{ v1: V1Memory; asV4: Memory }>;
  /** v4 global memories with no match in v1 — will be included in v1 export */
  newFromV4: Memory[];
  /** High similarity (>= threshold) — user reviews side-by-side */
  similar: SimilarPair[];
  /** Near-identical (>= 0.95 embedding or exact substring) — auto-skip */
  duplicates: DuplicatePair[];
  /** Method used for comparison */
  method: "embeddings" | "token-overlap";
}

// --- Thresholds ---

const EMBED_DUPLICATE_THRESHOLD = 0.95;
const EMBED_SIMILAR_THRESHOLD = 0.80;
const TOKEN_DUPLICATE_THRESHOLD = 0.75;
const TOKEN_SIMILAR_THRESHOLD = 0.40;

// --- Main ---

export async function reconcile(
  v1Memories: V1Memory[],
  v4GlobalMemories: Memory[],
): Promise<ReconciliationPlan> {
  const useEmbeddings = isEmbeddingEnabled();
  const method = useEmbeddings ? "embeddings" : "token-overlap";

  log("info", `Sync reconcile: ${v1Memories.length} v1, ${v4GlobalMemories.length} v4 global (method: ${method})`);

  // Convert v1 to v4 format for comparison
  const v1Converted = v1Memories.map((v1) => ({ v1, asV4: v1ToV4(v1) }));

  // Build similarity matrix
  const matches = useEmbeddings
    ? await matchByEmbeddings(v1Converted, v4GlobalMemories)
    : matchByTokenOverlap(v1Converted, v4GlobalMemories);

  // Bucket results
  const dupThreshold = useEmbeddings ? EMBED_DUPLICATE_THRESHOLD : TOKEN_DUPLICATE_THRESHOLD;
  const simThreshold = useEmbeddings ? EMBED_SIMILAR_THRESHOLD : TOKEN_SIMILAR_THRESHOLD;

  const plan: ReconciliationPlan = {
    newFromV1: [],
    newFromV4: [],
    similar: [],
    duplicates: [],
    method,
  };

  const matchedV4Ids = new Set<string>();

  for (const { v1, asV4, bestMatch, bestSimilarity } of matches) {
    if (bestMatch && bestSimilarity >= dupThreshold) {
      plan.duplicates.push({ v1: v1, v4: bestMatch, similarity: bestSimilarity });
      matchedV4Ids.add(bestMatch.id);
    } else if (bestMatch && bestSimilarity >= simThreshold) {
      plan.similar.push({
        v1: v1,
        v4: bestMatch,
        v1AsV4: asV4,
        similarity: bestSimilarity,
        suggestedMerge: mergeSuggestion(asV4, bestMatch),
      });
      matchedV4Ids.add(bestMatch.id);
    } else {
      plan.newFromV1.push({ v1: v1, asV4 });
    }
  }

  // v4 memories with no v1 match → included in v1 export
  for (const m of v4GlobalMemories) {
    if (!matchedV4Ids.has(m.id)) {
      plan.newFromV4.push(m);
    }
  }

  log("info", `Sync reconcile: ${plan.newFromV1.length} new from v1, ${plan.newFromV4.length} new from v4, ${plan.similar.length} similar, ${plan.duplicates.length} duplicates`);
  return plan;
}

// --- Embedding-based matching ---

interface MatchCandidate {
  v1: V1Memory;
  asV4: Memory;
  bestMatch: Memory | null;
  bestSimilarity: number;
}

async function matchByEmbeddings(
  v1Items: Array<{ v1: V1Memory; asV4: Memory }>,
  v4Memories: Memory[],
): Promise<MatchCandidate[]> {
  if (v1Items.length === 0) {
    return [];
  }

  const allTexts = [
    ...v1Items.map((item) => item.asV4.content),
    ...v4Memories.map((m) => m.content),
  ];

  const vectors = await embed(allTexts);
  if (vectors.length !== allTexts.length) {
    log("warn", "Sync: embedding failed, falling back to token overlap");
    return matchByTokenOverlap(v1Items, v4Memories);
  }

  const v1Vectors = vectors.slice(0, v1Items.length);
  const v4Vectors = vectors.slice(v1Items.length);

  const results: MatchCandidate[] = [];

  for (let i = 0; i < v1Items.length; i++) {
    let bestMatch: Memory | null = null;
    let bestSim = 0;

    for (let j = 0; j < v4Memories.length; j++) {
      const sim = cosineSimilarity(v1Vectors[i], v4Vectors[j]);
      if (sim > bestSim) {
        bestSim = sim;
        bestMatch = v4Memories[j];
      }
    }

    results.push({
      v1: v1Items[i].v1,
      asV4: v1Items[i].asV4,
      bestMatch,
      bestSimilarity: bestSim,
    });
  }

  return results;
}

// --- Token-overlap fallback ---

function matchByTokenOverlap(
  v1Items: Array<{ v1: V1Memory; asV4: Memory }>,
  v4Memories: Memory[],
): MatchCandidate[] {
  const results: MatchCandidate[] = [];

  for (const { v1, asV4 } of v1Items) {
    let bestMatch: Memory | null = null;
    let bestSim = 0;

    for (const v4 of v4Memories) {
      const sim = tokenOverlap(asV4.content, v4.content);
      if (sim > bestSim) {
        bestSim = sim;
        bestMatch = v4;
      }
    }

    results.push({ v1, asV4, bestMatch, bestSimilarity: bestSim });
  }

  return results;
}

/** Jaccard similarity over lowercased word tokens. */
function tokenOverlap(a: string, b: string): number {
  const tokensA = new Set(a.toLowerCase().split(/\s+/).filter((t) => t.length > 2));
  const tokensB = new Set(b.toLowerCase().split(/\s+/).filter((t) => t.length > 2));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }
  const union = tokensA.size + tokensB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

// --- Merge suggestion ---

/** Pre-compute a merge: take newer content, max salience per dimension, union tags. */
function mergeSuggestion(v1AsV4: Memory, v4: Memory): Memory {
  const v1Date = new Date(v1AsV4.created_at).getTime();
  const v4Date = new Date(v4.created_at).getTime();
  // Prefer the one with more content, breaking ties by recency
  const useV1Content = v1AsV4.content.length > v4.content.length ||
    (v1AsV4.content.length === v4.content.length && v1Date > v4Date);

  const mergedTags = [...new Set([...v4.tags, ...v1AsV4.tags])].slice(0, 5);
  const mergedSalience: Salience = {
    novelty: Math.max(v1AsV4.salience.novelty, v4.salience.novelty),
    relevance: Math.max(v1AsV4.salience.relevance, v4.salience.relevance),
    emotional: Math.max(v1AsV4.salience.emotional, v4.salience.emotional),
    predictive: Math.max(v1AsV4.salience.predictive, v4.salience.predictive),
  };

  return {
    ...v4, // keep v4 ID and metadata as base
    content: useV1Content ? v1AsV4.content : v4.content,
    salience: mergedSalience,
    tags: mergedTags,
    access_count: Math.max(v1AsV4.access_count, v4.access_count),
    last_accessed: newerTimestamp(v1AsV4.last_accessed, v4.last_accessed),
    consolidated: v1AsV4.consolidated || v4.consolidated,
  };
}

function newerTimestamp(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() > new Date(b).getTime() ? a : b;
}
