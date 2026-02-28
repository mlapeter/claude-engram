import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Memory } from "./types.js";
import { sanitizeSalience, generateId } from "./types.js";
import { loadConfig } from "./config.js";
import { calculateStrength } from "./strength.js";
import { log } from "./logger.js";
import type { MemoryStore } from "./store.js";

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

const CONSOLIDATION_SYSTEM_PROMPT = `You are a sleep consolidation processor for a memory system. Analyze these memories and optimize the memory bank.

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
 * Run a full consolidation cycle on a set of memories.
 * Uses Sonnet for intelligent merge/generalize/prune decisions.
 */
export async function runConsolidation(
  store: MemoryStore,
): Promise<ConsolidationResult> {
  const all = await store.loadAll();

  if (all.length === 0) {
    return { mergeCount: 0, generalizeCount: 0, pruneCount: 0, notes: "No memories to consolidate." };
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
      autoPruned++;
    }
  }
  if (autoPruned > 0) {
    log("info", `Auto-pruned ${autoPruned} decayed memories`);
  }

  // Reload after pruning
  const remaining = await store.loadAll();
  if (remaining.length === 0) {
    return { mergeCount: 0, generalizeCount: 0, pruneCount: autoPruned, notes: "All memories pruned due to decay." };
  }

  // Step 3: Send to Sonnet for intelligent consolidation
  const memoriesText = remaining
    .map((m) => {
      const strength = calculateStrength(m);
      return `[${m.id}] (${m.scope}, strength=${strength.toFixed(2)}) [${m.tags.join(",")}] ${m.content}`;
    })
    .join("\n");

  try {
    const response = await getClient().messages.create({
      model: config.consolidationModel,
      max_tokens: 8000,
      system: CONSOLIDATION_SYSTEM_PROMPT,
      messages: [{ role: "user", content: `MEMORY BANK (${remaining.length} memories):\n\n${memoriesText}` }],
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
      return { mergeCount: 0, generalizeCount: 0, pruneCount: autoPruned, notes: "API returned no content." };
    }

    const parsed = JSON.parse(textBlock.text);
    const result = ConsolidationResponseSchema.parse(parsed);

    return await applyConsolidation(store, remaining, result, autoPruned);
  } catch (error) {
    log("error", `Consolidation API call failed: ${error instanceof Error ? error.message : String(error)}`);
    return { mergeCount: 0, generalizeCount: 0, pruneCount: autoPruned, notes: `API error, only auto-pruning applied. ${error instanceof Error ? error.message : ""}` };
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
      await store.remove(id);
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
  for (const scope of ["global", "project"] as const) {
    const meta = await store.loadMeta(scope);
    meta.lastConsolidation = new Date().toISOString();
    await store.saveMeta(scope, meta);
  }

  const notes = result.notes + (autoPruned > 0 ? ` (+ ${autoPruned} auto-pruned from decay)` : "");
  log("info", `Consolidation complete: ${mergeCount} merges, ${result.generalize.length} generalizations, ${pruneCount} prunes`);

  return {
    mergeCount,
    generalizeCount: result.generalize.length,
    pruneCount,
    notes,
  };
}
