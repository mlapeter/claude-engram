import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Memory } from "./types.js";
import { sanitizeSalience, generateId, getDataDir } from "./types.js";
import { loadConfig } from "./config.js";
import { calculateStrength } from "./strength.js";
import { log } from "./logger.js";
import type { MemoryStore } from "./store.js";
import { tokenize, tokenOverlap } from "./store.js";
import { recordSignal } from "./salience-weights.js";
import {
  isEmbeddingEnabled,
  cosineSimilarity,
  loadEmbeddingIndex,
  type EmbeddingIndex,
} from "./embeddings.js";

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic();
  }
  return client;
}

export interface ConsolidationResult {
  mergeCount: number;
  generalizeCount: number;
  pruneCount: number;
  promotionCount: number;
  notes: string;
}

// --- Zod schemas for API response validation ---

const MergeSchema = z.object({
  ids: z.array(z.string()),
  merged: z.object({
    content: z.string(),
    salience: z.object({
      novelty: z.number(),
      relevance: z.number(),
      emotional: z.number(),
      predictive: z.number(),
    }),
    tags: z.array(z.string()),
  }),
});

const ConsolidationResponseSchema = z.object({
  merge: z.array(MergeSchema),
  generalize: z.array(
    z.object({
      content: z.string(),
      salience: z.object({
        novelty: z.number(),
        relevance: z.number(),
        emotional: z.number(),
        predictive: z.number(),
      }),
      tags: z.array(z.string()),
    }),
  ),
  prune_ids: z.array(z.string()),
  notes: z.string(),
});

const CONSOLIDATION_SCHEMA = {
  type: "object" as const,
  properties: {
    merge: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          ids: { type: "array" as const, items: { type: "string" as const } },
          merged: {
            type: "object" as const,
            properties: {
              content: { type: "string" as const },
              salience: {
                type: "object" as const,
                properties: {
                  novelty: { type: "number" as const },
                  relevance: { type: "number" as const },
                  emotional: { type: "number" as const },
                  predictive: { type: "number" as const },
                },
                required: ["novelty", "relevance", "emotional", "predictive"] as const,
                additionalProperties: false as const,
              },
              tags: { type: "array" as const, items: { type: "string" as const } },
            },
            required: ["content", "salience", "tags"] as const,
            additionalProperties: false as const,
          },
        },
        required: ["ids", "merged"] as const,
        additionalProperties: false as const,
      },
    },
    generalize: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          content: { type: "string" as const },
          salience: {
            type: "object" as const,
            properties: {
              novelty: { type: "number" as const },
              relevance: { type: "number" as const },
              emotional: { type: "number" as const },
              predictive: { type: "number" as const },
            },
            required: ["novelty", "relevance", "emotional", "predictive"] as const,
            additionalProperties: false as const,
          },
          tags: { type: "array" as const, items: { type: "string" as const } },
        },
        required: ["content", "salience", "tags"] as const,
        additionalProperties: false as const,
      },
    },
    prune_ids: { type: "array" as const, items: { type: "string" as const } },
    notes: { type: "string" as const },
  },
  required: ["merge", "generalize", "prune_ids", "notes"] as const,
  additionalProperties: false as const,
};

const CONSOLIDATION_SYSTEM_PROMPT = `You are processing Claude's memory bank during a consolidation cycle. Analyze these memories and optimize the memory bank.

Your tasks:
1. **Merge redundant memories** — If two or more memories say essentially the same thing (even with slight wording differences), combine them into one stronger, more complete memory. Use the best details from each.
2. **Resolve contradictions** — If memories contradict each other, keep the most recent information and merge into one updated memory.
3. **Extract patterns** — If you see recurring themes across 3+ memories, create a new generalized memory that captures the pattern. Keep it concise.
4. **Flag for pruning** — Identify memories that are trivial, fully superseded by a merge, or no longer relevant.

Rules:
- Merged content must be ≤400 characters
- Generalized content must be ≤400 characters
- Only prune memories that are truly redundant or trivial — err on the side of keeping
- Each memory ID can appear in at most ONE merge group
- Do NOT prune memories that are still uniquely informative
- Salience scores should reflect the consolidated importance (0.0-1.0)
- Assign 1-5 tags from: identity, goal, preference, project, relationship, skill, insight, contradiction, pattern, context, technical, personal, business, creative`;

/**
 * Update lastConsolidation timestamp in meta for both scopes.
 * Called after every consolidation attempt (even if nothing was consolidated)
 * to prevent infinite re-triggering.
 */
async function updateConsolidationTimestamp(store: MemoryStore): Promise<void> {
  const now = new Date().toISOString();
  for (const scope of ["global", "project"] as const) {
    const meta = await store.loadMeta(scope);
    meta.lastConsolidation = now;
    await store.saveMeta(scope, meta);
  }
}

/** Lock file path for preventing concurrent consolidation runs */
function consolidationLockPath(): string {
  return join(getDataDir(), "consolidation.lock");
}

/**
 * Run a full consolidation cycle on a set of memories.
 * Uses Sonnet for intelligent merge/generalize/prune decisions.
 *
 * Guarded by a lock file to prevent concurrent runs.
 */
export async function runConsolidation(
  store: MemoryStore,
): Promise<ConsolidationResult> {
  // Prevent concurrent consolidation runs
  const lockPath = consolidationLockPath();
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, String(process.pid), { flag: "wx" }); // fails if exists
  } catch {
    // Check if lock is stale (older than 10 minutes = stuck consolidation)
    try {
      const stat = statSync(lockPath);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs > 10 * 60_000) {
        log("warn", `Consolidation: removing stale lock (${(ageMs / 60_000).toFixed(1)}min old)`);
        unlinkSync(lockPath);
        writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      } else {
        log("info", "Consolidation: skipped (already running)");
        return { mergeCount: 0, generalizeCount: 0, pruneCount: 0, promotionCount: 0, notes: "Skipped: concurrent consolidation in progress." };
      }
    } catch {
      log("info", "Consolidation: skipped (lock contention)");
      return { mergeCount: 0, generalizeCount: 0, pruneCount: 0, promotionCount: 0, notes: "Skipped: lock contention." };
    }
  }

  try {
    return await runConsolidationInner(store);
  } finally {
    // Always release lock
    try { unlinkSync(lockPath); } catch { /* already removed */ }
  }
}

async function runConsolidationInner(
  store: MemoryStore,
): Promise<ConsolidationResult> {
  const all = await store.loadAll();

  if (all.length === 0) {
    await updateConsolidationTimestamp(store);
    return { mergeCount: 0, generalizeCount: 0, pruneCount: 0, promotionCount: 0, notes: "No memories to consolidate." };
  }

  // Step 1: Backup before consolidation
  const backupPath = await store.backup();
  log("info", `Consolidation backup: ${backupPath}`);

  const config = loadConfig();

  // Step 2: Auto-prune below threshold
  let autoPruned = 0;
  for (const m of all) {
    if (calculateStrength(m) < config.pruneThreshold) {
      await store.remove(m.id);
      await recordSignal(store, "prune", m.salience);
      autoPruned++;
    }
  }
  if (autoPruned > 0) {
    log("info", `Auto-pruned ${autoPruned} decayed memories`);
  }

  // Reload after pruning
  const remaining = await store.loadAll();
  if (remaining.length === 0) {
    await updateConsolidationTimestamp(store);
    return { mergeCount: 0, generalizeCount: 0, pruneCount: autoPruned, promotionCount: 0, notes: "All memories pruned due to decay." };
  }

  // Step 3: Episodic→Semantic promotion (Fuzzy Trace Theory)
  // Episodic details fade to semantic gist after 7+ days
  const PROMOTION_AGE_DAYS = 7;
  const now = Date.now();
  const promotable = remaining.filter((m) => {
    const type = (m as Memory & { memory_type?: string }).memory_type ?? "episodic";
    if (type !== "episodic") return false;
    if (m.consolidated) return false; // already processed
    const ageMs = now - new Date(m.created_at).getTime();
    return ageMs > PROMOTION_AGE_DAYS * 86_400_000;
  });

  let promotionCount = 0;
  if (promotable.length > 0) {
    try {
      const gistResponse = await getClient().messages.create({
        model: config.extractionModel, // Haiku — cheap batch compression
        max_tokens: 4000,
        system: "Compress each episodic memory to its semantic gist. Keep essential meaning, drop episodic detail (dates, exact sequences). Max 400 chars each. Return JSON array of {id, gist} objects.",
        messages: [{
          role: "user",
          content: JSON.stringify(promotable.map((m) => ({ id: m.id, content: m.content }))),
        }],
        output_config: {
          format: {
            type: "json_schema",
            schema: {
              type: "object" as const,
              properties: {
                items: {
                  type: "array" as const,
                  items: {
                    type: "object" as const,
                    properties: {
                      id: { type: "string" as const },
                      gist: { type: "string" as const },
                    },
                    required: ["id", "gist"] as const,
                    additionalProperties: false as const,
                  },
                },
              },
              required: ["items"] as const,
              additionalProperties: false as const,
            },
          },
        },
      });

      const gistBlock = gistResponse.content.find((b) => b.type === "text");
      if (gistBlock && gistBlock.type === "text") {
        const gistResult = JSON.parse(gistBlock.text) as { items: Array<{ id: string; gist: string }> };
        for (const { id, gist } of gistResult.items) {
          await store.update(id, {
            content: gist.slice(0, 400),
            memory_type: "semantic",
          } as Partial<Memory>);
          promotionCount++;
        }
        log("info", `Promoted ${promotionCount} episodic→semantic memories`);
      }
    } catch (err) {
      log("warn", `Episodic→semantic promotion failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Reload after promotions
  const postPromotion = promotionCount > 0 ? await store.loadAll() : remaining;

  // Step 4: Intelligent consolidation (single-pass or two-pass based on memory count)
  const useTwoPass = postPromotion.length > config.consolidationBatchThreshold;

  if (useTwoPass) {
    return await twoPassConsolidation(store, config, postPromotion, autoPruned, promotionCount);
  } else {
    return await singlePassConsolidation(store, config, postPromotion, autoPruned, promotionCount);
  }
}

function formatMemoriesText(memories: Memory[]): string {
  return memories
    .map((m) => {
      const strength = calculateStrength(m);
      const type = (m as Memory & { memory_type?: string }).memory_type ?? "episodic";
      return `[${m.id}] (${m.scope}, ${type}, strength=${strength.toFixed(2)}) [${m.tags.join(",")}] ${m.content}`;
    })
    .join("\n");
}

/**
 * Original single-pass: send all memories to Sonnet.
 * Used when memory count is below consolidationBatchThreshold.
 */
async function singlePassConsolidation(
  store: MemoryStore,
  config: ReturnType<typeof loadConfig>,
  memories: Memory[],
  autoPruned: number,
  promotionCount: number,
): Promise<ConsolidationResult> {
  const memoriesText = formatMemoriesText(memories);

  try {
    const response = await getClient().messages.create({
      model: config.consolidationModel,
      max_tokens: 8000,
      system: CONSOLIDATION_SYSTEM_PROMPT,
      messages: [{ role: "user", content: `MEMORY BANK (${memories.length} memories):\n\n${memoriesText}` }],
      output_config: {
        format: {
          type: "json_schema",
          schema: CONSOLIDATION_SCHEMA,
        },
      },
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      log("warn", "No text block in consolidation response");
      await updateConsolidationTimestamp(store);
      return { mergeCount: 0, generalizeCount: 0, pruneCount: autoPruned, promotionCount, notes: "API returned no content." };
    }

    const parsed = JSON.parse(textBlock.text);
    const result = ConsolidationResponseSchema.parse(parsed);

    return await applyConsolidation(store, memories, result, autoPruned, promotionCount);
  } catch (error) {
    log("error", `Consolidation API call failed: ${error instanceof Error ? error.message : String(error)}`);
    await updateConsolidationTimestamp(store);
    return { mergeCount: 0, generalizeCount: 0, pruneCount: autoPruned, promotionCount, notes: `API error, only auto-pruning applied. ${error instanceof Error ? error.message : ""}` };
  }
}

/**
 * Find groups of similar memories using embedding cosine similarity.
 * Replaces Haiku-based clustering — deterministic, fast, no API call.
 * Falls back to token overlap when embeddings aren't available.
 */
function findSimilarGroups(
  memories: Memory[],
  globalIndex: EmbeddingIndex,
  projectIndex: EmbeddingIndex,
  threshold: number = 0.8,
): string[][] {
  // Build adjacency via pairwise similarity
  const adjacent = new Map<string, Set<string>>();

  for (let i = 0; i < memories.length; i++) {
    const mi = memories[i];
    const idxI = mi.scope === "global" ? globalIndex : projectIndex;
    const vecI = idxI[mi.id];
    if (!vecI) continue;

    for (let j = i + 1; j < memories.length; j++) {
      const mj = memories[j];
      const idxJ = mj.scope === "global" ? globalIndex : projectIndex;
      const vecJ = idxJ[mj.id];
      if (!vecJ) continue;

      if (cosineSimilarity(vecI, vecJ) >= threshold) {
        if (!adjacent.has(mi.id)) adjacent.set(mi.id, new Set());
        if (!adjacent.has(mj.id)) adjacent.set(mj.id, new Set());
        adjacent.get(mi.id)!.add(mj.id);
        adjacent.get(mj.id)!.add(mi.id);
      }
    }
  }

  // Connected components via BFS
  const visited = new Set<string>();
  const groups: string[][] = [];

  for (const [id] of adjacent) {
    if (visited.has(id)) continue;
    const group: string[] = [];
    const queue = [id];
    while (queue.length > 0) {
      const current = queue.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      group.push(current);
      const neighbors = adjacent.get(current);
      if (neighbors) {
        for (const n of neighbors) {
          if (!visited.has(n)) queue.push(n);
        }
      }
    }
    if (group.length >= 2) groups.push(group);
  }

  return groups;
}

/**
 * Token-overlap fallback for similarity grouping when embeddings aren't available.
 */
function findSimilarGroupsByTokens(
  memories: Memory[],
  threshold: number = 0.7,
): string[][] {
  const tokenSets = memories.map((m) => ({
    id: m.id,
    tokens: tokenize(m.content),
  }));

  const adjacent = new Map<string, Set<string>>();

  for (let i = 0; i < tokenSets.length; i++) {
    for (let j = i + 1; j < tokenSets.length; j++) {
      const overlap = tokenOverlap(tokenSets[i].tokens, tokenSets[j].tokens);
      if (overlap >= threshold) {
        const idI = tokenSets[i].id;
        const idJ = tokenSets[j].id;
        if (!adjacent.has(idI)) adjacent.set(idI, new Set());
        if (!adjacent.has(idJ)) adjacent.set(idJ, new Set());
        adjacent.get(idI)!.add(idJ);
        adjacent.get(idJ)!.add(idI);
      }
    }
  }

  const visited = new Set<string>();
  const groups: string[][] = [];
  for (const [id] of adjacent) {
    if (visited.has(id)) continue;
    const group: string[] = [];
    const queue = [id];
    while (queue.length > 0) {
      const current = queue.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      group.push(current);
      const neighbors = adjacent.get(current);
      if (neighbors) {
        for (const n of neighbors) {
          if (!visited.has(n)) queue.push(n);
        }
      }
    }
    if (group.length >= 2) groups.push(group);
  }

  return groups;
}

/**
 * Two-pass consolidation: embedding similarity identifies merge candidates, Sonnet processes them.
 * Used when memory count exceeds consolidationBatchThreshold.
 */
async function twoPassConsolidation(
  store: MemoryStore,
  config: ReturnType<typeof loadConfig>,
  memories: Memory[],
  autoPruned: number,
  promotionCount: number,
): Promise<ConsolidationResult> {
  const memById = new Map(memories.map((m) => [m.id, m]));

  // Step 4a: Find similar memory groups (deterministic, no API call for clustering)
  let groups: string[][];
  if (isEmbeddingEnabled()) {
    const paths = store.getEmbeddingPaths();
    const globalIndex = loadEmbeddingIndex(paths.global);
    const projectIndex = loadEmbeddingIndex(paths.project);
    groups = findSimilarGroups(memories, globalIndex, projectIndex, 0.8);
    log("info", `Two-pass: embedding similarity found ${groups.length} groups from ${memories.length} memories`);
  } else {
    groups = findSimilarGroupsByTokens(memories, 0.7);
    log("info", `Two-pass: token overlap found ${groups.length} groups from ${memories.length} memories`);
  }

  // Collect all IDs from groups
  const candidateIds = new Set<string>();
  for (const group of groups) {
    for (const id of group) {
      if (memById.has(id)) {
        candidateIds.add(id);
      }
    }
  }

  // If no candidates found, nothing to consolidate — but still update timestamp
  if (candidateIds.size === 0) {
    await updateConsolidationTimestamp(store);
    return { mergeCount: 0, generalizeCount: 0, pruneCount: autoPruned, promotionCount, notes: "No merge candidates identified." };
  }

  // Step 4b: Sonnet consolidation — only on candidates
  const candidates = memories.filter((m) => candidateIds.has(m.id));
  const memoriesText = formatMemoriesText(candidates);
  const standaloneCount = memories.length - candidates.length;

  try {
    const response = await getClient().messages.create({
      model: config.consolidationModel,
      max_tokens: 8000,
      system: CONSOLIDATION_SYSTEM_PROMPT,
      messages: [{ role: "user", content: `MEMORY BANK (${candidates.length} candidates for consolidation, ${standaloneCount} standalone memories omitted):\n\n${memoriesText}` }],
      output_config: {
        format: {
          type: "json_schema",
          schema: CONSOLIDATION_SCHEMA,
        },
      },
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      log("warn", "No text block in consolidation response");
      await updateConsolidationTimestamp(store);
      return { mergeCount: 0, generalizeCount: 0, pruneCount: autoPruned, promotionCount, notes: "API returned no content." };
    }

    const parsed = JSON.parse(textBlock.text);
    const result = ConsolidationResponseSchema.parse(parsed);

    // Pass full memories list so applyConsolidation can look up any referenced ID
    const consolResult = await applyConsolidation(store, memories, result, autoPruned, promotionCount);
    consolResult.notes += ` (two-pass: ${candidates.length} candidates, ${standaloneCount} standalone skipped)`;
    return consolResult;
  } catch (error) {
    log("error", `Two-pass Sonnet call failed: ${error instanceof Error ? error.message : String(error)}`);
    await updateConsolidationTimestamp(store);
    return { mergeCount: 0, generalizeCount: 0, pruneCount: autoPruned, promotionCount, notes: `API error in two-pass Sonnet. ${error instanceof Error ? error.message : ""}` };
  }
}

/**
 * Apply the consolidation result to the store.
 */
async function applyConsolidation(
  store: MemoryStore,
  memories: Memory[],
  result: z.infer<typeof ConsolidationResponseSchema>,
  autoPruned: number,
  promotionCount: number,
): Promise<ConsolidationResult> {
  const memById = new Map(memories.map((m) => [m.id, m]));
  let mergeCount = 0;
  let pruneCount = autoPruned;
  const newMemories: Memory[] = [];

  // Apply merges
  for (const merge of result.merge) {
    const sourceIds = merge.ids.filter((id) => memById.has(id));
    if (sourceIds.length < 2) continue;

    // Find the oldest created_at and highest access_count among sources
    const sources = sourceIds.map((id) => memById.get(id)!);
    const oldestCreated = sources.reduce((oldest, m) =>
      m.created_at < oldest ? m.created_at : oldest,
      sources[0].created_at,
    );
    const totalAccess = sources.reduce((sum, m) => sum + m.access_count, 0);
    const scope = sources[0].scope; // preserve scope from first source

    const merged: Memory = {
      id: generateId(),
      content: merge.merged.content.slice(0, 400),
      scope,
      memory_type: "semantic", // Merged memories are always semantic
      salience: sanitizeSalience(merge.merged.salience),
      tags: merge.merged.tags.slice(0, 5),
      access_count: totalAccess,
      last_accessed: new Date().toISOString(),
      created_at: oldestCreated,
      consolidated: true,
      generalized: false,
      source_session: "consolidation",
      updated_from: sourceIds[0],
    };

    // Remove source memories
    for (const id of sourceIds) {
      await store.remove(id);
      memById.delete(id);
    }

    newMemories.push(merged);
    mergeCount++;
  }

  // Apply prunes (only IDs that still exist and weren't already merged)
  for (const id of result.prune_ids) {
    if (memById.has(id)) {
      const pruned = memById.get(id)!;
      await store.remove(id);
      await recordSignal(store, "prune", pruned.salience);
      memById.delete(id);
      pruneCount++;
    }
  }

  // Create generalized memories
  for (const gen of result.generalize) {
    const genMemory: Memory = {
      id: generateId(),
      content: gen.content.slice(0, 400),
      scope: "global", // patterns are typically global
      memory_type: "semantic", // Generalized memories are always semantic
      salience: sanitizeSalience(gen.salience),
      tags: gen.tags.slice(0, 5),
      access_count: 0,
      last_accessed: null,
      created_at: new Date().toISOString(),
      consolidated: true,
      generalized: true,
      source_session: "consolidation",
      updated_from: null,
    };
    newMemories.push(genMemory);
  }

  // Add all new memories to store
  if (newMemories.length > 0) {
    await store.add(newMemories);
  }

  // Update meta with consolidation timestamp
  await updateConsolidationTimestamp(store);

  const notes = result.notes
    + (autoPruned > 0 ? ` (+ ${autoPruned} auto-pruned from decay)` : "")
    + (promotionCount > 0 ? ` (+ ${promotionCount} episodic→semantic)` : "");
  log("info", `Consolidation complete: ${mergeCount} merges, ${result.generalize.length} generalizations, ${pruneCount} prunes, ${promotionCount} promotions`);

  return {
    mergeCount,
    generalizeCount: result.generalize.length,
    pruneCount,
    promotionCount,
    notes,
  };
}
