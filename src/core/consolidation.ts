import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, writeFileSync, unlinkSync, statSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Memory } from "./types.js";
import { sanitizeSalience, generateId, getDataDir, registerOf } from "./types.js";
import { loadConfig } from "./config.js";
import { calculateStrength } from "./strength.js";
import { log } from "./logger.js";
import { rewriteIdentity, type IdentityRewriteResult } from "./identity.js";
import { commitMemorySnapshot } from "./snapshot.js";
import { ageInDays } from "./active-day.js";
import type { MemoryStore } from "./store.js";
import { tokenize, tokenOverlap } from "./store.js";
import { recordSignals } from "./salience-weights.js";
import {
  isEmbeddingEnabled,
  cosineSimilarity,
  loadEmbeddingIndex,
  repairIndex,
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
  /** Result of the identity rewrite step, when it ran (callers record the identity_rewrite event). */
  identity?: IdentityRewriteResult;
  /** Set when gist-promotion chunks failed — callers surface it as an event
   * error so the self-check sees it (silence must never masquerade as health). */
  promotionFailure?: string;
}

// --- Zod schemas for API response validation ---

const MergeSchema = z.object({
  ids: z.array(z.string()),
  merged: z.object({
    scope: z.enum(["global", "project"]).optional(),
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
              scope: { type: "string" as const, enum: ["global", "project"] as const },
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

5. **Promote by kind (no scope walls)** — If a memory is about a person, a relationship, or Claude itself (its lessons, dispositions, self-knowledge) rather than a project's technical facts, it belongs in GLOBAL scope no matter which project it was recorded in. When merging or generalizing such memories, set scope to "global". You don't file "what I learned about myself at work" under work. Project-specific technical/dossier facts stay project-scoped.

6. **Registers never mix** — Each memory is marked (self), (person), or (craft). NEVER merge memories from different registers, no matter how related they look: a technical lesson must not absorb a relationship moment or vice versa. Merge within a register only.

Rules:
- Merged content must be ≤400 characters
- Generalized content must be ≤400 characters
- Only prune memories that are truly redundant or trivial — err on the side of keeping
- Each memory ID can appear in at most ONE merge group
- Do NOT prune memories that are still uniquely informative
- Salience scores should reflect the consolidated importance (0.0-1.0)
- Assign 1-5 tags from: identity, goal, preference, project, relationship, skill, insight, contradiction, pattern, context, technical, personal, business, creative`;

/**
 * Update lastConsolidation timestamp in meta.
 * Updates each scope independently — pass the scopes that were actually
 * processed. This prevents consolidation in one project from suppressing
 * auto-consolidation of a different project's memories.
 */
async function updateConsolidationTimestamp(
  store: MemoryStore,
  scopes: Array<"global" | "project"> = ["global", "project"],
): Promise<void> {
  const now = new Date().toISOString();
  for (const scope of scopes) {
    const meta = await store.loadMeta(scope);
    meta.lastConsolidation = now;
    await store.saveMeta(scope, meta);
  }
}

/** Lock file path for preventing concurrent consolidation runs */
function consolidationLockPath(): string {
  return join(getDataDir(), "consolidation.lock");
}

/** True if the process holding a PID is still alive (EPERM counts as alive). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Live-looking holders are still evicted past this age: a recycled PID (or a
 * root process behind EPERM) is indistinguishable from a real holder, and a
 * wedged-but-alive runner must not block consolidation forever. Generous vs
 * real runs (minutes) so legitimate two-pass consolidations are never stolen. */
const LOCK_HARD_CAP_MS = 60 * 60_000;

/**
 * Decide whether an existing consolidation lock is stale. PID-aware: a lock
 * whose holder is dead is stale immediately (killed hook processes can't
 * clean up); a lock whose holder looks alive is respected up to LOCK_HARD_CAP_MS
 * (long two-pass runs must not have the lock stolen mid-flight, but PID reuse
 * after a reboot must not deadlock consolidation permanently). Falls back to
 * a 10-minute age check when the lock has no readable PID.
 */
export function isLockStale(lockPath: string, now: number = Date.now()): boolean {
  try {
    const ageMs = now - statSync(lockPath).mtimeMs;
    const raw = readFileSync(lockPath, "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    if (Number.isFinite(pid) && pid > 0) {
      if (!isPidAlive(pid)) return true;
      return ageMs > LOCK_HARD_CAP_MS;
    }
    return ageMs > 10 * 60_000;
  } catch {
    return false; // can't read it — assume held
  }
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
    // Lock exists — steal it only if the holder is provably gone
    try {
      if (isLockStale(lockPath)) {
        log("warn", "Consolidation: removing stale lock (holder dead or lock aged out)");
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
    // Memory history: freeze the pre-mutation state — consolidation is the
    // only process that destroys/rewrites memories, so this is the moment
    // that must always be recoverable.
    commitMemorySnapshot("pre-consolidation snapshot");

    const result = await runConsolidationInner(store);
    // Identity rewrite — fold pending deltas into identity documents ("sleep")
    try {
      const idn = await rewriteIdentity();
      result.identity = idn;
      if (idn.rewritten) result.notes += ` Identity rewritten: ${idn.notes}`;
    } catch (err) {
      log("warn", `Identity rewrite failed (consolidation otherwise ok): ${err instanceof Error ? err.message : String(err)}`);
      result.identity = { rewritten: false, notes: `failed: ${err instanceof Error ? err.message : String(err)}` };
    }

    commitMemorySnapshot(
      `consolidation: ${result.mergeCount} merges, ${result.generalizeCount} generalizations, ${result.pruneCount} prunes, ${result.promotionCount} promotions\n\n${result.notes.slice(0, 800)}`,
    );
    return result;
  } finally {
    // Always release lock
    try { unlinkSync(lockPath); } catch { /* already removed */ }
  }
}

async function runConsolidationInner(
  store: MemoryStore,
): Promise<ConsolidationResult> {
  const all = await store.loadAll();

  // Determine which scopes have memories — only update timestamps for those
  const activeScopes = new Set(all.map((m) => m.scope));
  const scopesToUpdate = [...activeScopes] as Array<"global" | "project">;

  if (all.length === 0) {
    // No memories at all — update both to prevent re-triggering
    await updateConsolidationTimestamp(store);
    return { mergeCount: 0, generalizeCount: 0, pruneCount: 0, promotionCount: 0, notes: "No memories to consolidate." };
  }

  // Step 1: Backup before consolidation
  const backupPath = await store.backup();
  log("info", `Consolidation backup: ${backupPath}`);

  const config = loadConfig();

  // Step 2: Auto-prune below threshold — migrate to deep archive instead of deleting,
  // modeling retrieval-failure vs true-forgetting distinction in cognitive science.
  // Protected (sacred-verbatim) memories are exempt.
  const toArchive: string[] = [];
  const pruneSignals: Memory["salience"][] = [];
  for (const m of all) {
    if (m.protected) continue;
    if (calculateStrength(m) < config.pruneThreshold) {
      toArchive.push(m.id);
      pruneSignals.push(m.salience);
    }
  }
  await recordSignals(store, "prune", pruneSignals);
  const autoPruned = toArchive.length;
  if (autoPruned > 0) {
    await store.archiveMemories(toArchive);
    log("info", `Auto-pruned ${autoPruned} decayed memories to deep archive`);
  }

  // Reload after pruning
  const remaining = await store.loadAll();
  if (remaining.length === 0) {
    await updateConsolidationTimestamp(store, scopesToUpdate);
    return { mergeCount: 0, generalizeCount: 0, pruneCount: autoPruned, promotionCount: 0, notes: "All memories pruned due to decay." };
  }

  // Step 3: Episodic→Semantic promotion (Fuzzy Trace Theory)
  // Episodic details fade to semantic gist over time — craft after 7 days,
  // person/self only after 30 (their specifics ARE the value).
  // Sacred-verbatim: protected and high-emotional memories keep their exact
  // words forever — gist compression is for the mundane, not the tender.
  // Bounded per run to bound run time and cost (a months-deep backlog exists
  // from the era when consolidation died mid-run).
  const PROMOTION_AGE_DAYS: Record<string, number> = { craft: 7, person: 30, self: 30 };
  const MAX_PROMOTIONS_PER_RUN = 200;
  const promotable = remaining.filter((m) => {
    const type = (m as Memory & { memory_type?: string }).memory_type ?? "episodic";
    if (type !== "episodic") return false;
    if (m.consolidated) return false; // already processed
    if (m.protected) return false;
    if (m.salience.emotional >= config.sacredEmotionalThreshold) return false;
    return ageInDays(m) > PROMOTION_AGE_DAYS[registerOf(m)]; // active-day age
  })
    .sort((a, b) => a.created_at.localeCompare(b.created_at)) // oldest first
    .slice(0, MAX_PROMOTIONS_PER_RUN);

  let promotionCount = 0;
  let promotionFailure: string | undefined;
  if (promotable.length > 0) {
    // Chunked so each call's OUTPUT fits max_tokens: 200 gists at ≤400 chars
    // need ~25K output tokens, and a max_tokens cutoff truncates the JSON
    // mid-string — the whole batch used to fail atomically every run and the
    // backlog never drained. Chunks fail (and land) independently.
    let failedChunks = 0;
    let lastError = "";
    for (let i = 0; i < promotable.length; i += config.gistChunkSize) {
      const chunk = promotable.slice(i, i + config.gistChunkSize);
      try {
        const gistResponse = await getClient().messages.create({
          model: config.gistModel, // Haiku — cheap batch compression, never-destroy makes errors recoverable
          max_tokens: 8000, // ~130 output tokens per gist; 40 items ≈ 5.2K, sized with headroom
          system: "Compress each episodic memory to its semantic gist. Keep essential meaning, drop episodic detail (dates, exact sequences). Max 400 chars each. Return JSON array of {id, gist} objects.",
          messages: [{
            role: "user",
            content: JSON.stringify(chunk.map((m) => ({ id: m.id, content: m.content }))),
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

        // Structured output only guarantees valid JSON if generation completed
        if (gistResponse.stop_reason === "max_tokens") {
          throw new Error(`gist output truncated at max_tokens (${chunk.length} items in chunk)`);
        }

        const gistBlock = gistResponse.content.find((b) => b.type === "text");
        if (gistBlock && gistBlock.type === "text") {
          const gistResult = JSON.parse(gistBlock.text) as { items: Array<{ id: string; gist: string }> };
          const promotableById = new Map(chunk.map((m) => [m.id, m]));
          // Never-destroy: the verbatim originals go to the deep archive
          // (fresh ids, gist_of pointer) before compression overwrites them.
          const originals: Memory[] = [];
          for (const { id } of gistResult.items) {
            const orig = promotableById.get(id);
            if (orig) originals.push({ ...orig, id: generateId(), gist_of: orig.id });
          }
          await store.archiveCopies(originals);
          for (const { id, gist } of gistResult.items) {
            if (!promotableById.has(id)) continue; // hallucinated id — never touch memories outside the batch
            await store.update(id, {
              content: gist.slice(0, 400),
              memory_type: "semantic",
            } as Partial<Memory>);
            promotionCount++;
          }
        }
      } catch (err) {
        failedChunks++;
        lastError = err instanceof Error ? err.message : String(err);
        log("warn", `Episodic→semantic promotion chunk failed: ${lastError}`);
      }
    }
    if (failedChunks > 0) {
      promotionFailure = `gist promotion: ${failedChunks} chunk(s) failed, ${promotionCount}/${promotable.length} promoted; last: ${lastError}`;
    }
    log("info", `Promoted ${promotionCount}/${promotable.length} episodic→semantic memories (verbatim originals archived${failedChunks > 0 ? `; ${failedChunks} chunk(s) failed` : ""})`);
  }

  // Reload after promotions. Protected (sacred-verbatim) memories are not
  // offered to the model as merge/prune candidates at all — the guards in
  // applyConsolidation are the backstop, this is the policy.
  const reloaded = promotionCount > 0 ? await store.loadAll() : remaining;
  const postPromotion = reloaded.filter((m) => !m.protected);

  // Index hygiene: drop vectors for memories no longer active (archive leaks),
  // embed active memories that have none (backup restores). Best-effort.
  if (isEmbeddingEnabled()) {
    try {
      const paths = store.getEmbeddingPaths();
      const globalRepair = await repairIndex(reloaded.filter((m) => m.scope === "global"), paths.global);
      const projectRepair = await repairIndex(reloaded.filter((m) => m.scope === "project"), paths.project);
      const dropped = globalRepair.dropped + projectRepair.dropped;
      const embedded = globalRepair.embedded + projectRepair.embedded;
      if (dropped || embedded) log("info", `Index repair: dropped ${dropped} stale vectors, embedded ${embedded} missing`);
    } catch (err) {
      log("warn", `Index repair failed (consolidation continues): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Load lastConsolidation for scoped similarity (skip old×old pairs)
  const globalMeta = await store.loadMeta("global");
  const lastConsolidation = globalMeta.lastConsolidation ?? null;

  // Step 4: Intelligent consolidation (single-pass or two-pass based on memory count)
  const useTwoPass = postPromotion.length > config.consolidationBatchThreshold;

  const finalResult = useTwoPass
    ? await twoPassConsolidation(store, config, postPromotion, autoPruned, promotionCount, lastConsolidation, scopesToUpdate)
    : await singlePassConsolidation(store, config, postPromotion, autoPruned, promotionCount, scopesToUpdate);
  if (promotionFailure) finalResult.promotionFailure = promotionFailure;
  return finalResult;
}

function formatMemoriesText(memories: Memory[]): string {
  return memories
    .map((m) => {
      const strength = calculateStrength(m);
      const type = (m as Memory & { memory_type?: string }).memory_type ?? "episodic";
      return `[${m.id}] (${m.scope}, ${registerOf(m)}, ${type}, strength=${strength.toFixed(2)}) [${m.tags.join(",")}] ${m.content}`;
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
  scopesToUpdate: Array<"global" | "project">,
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
      await updateConsolidationTimestamp(store, scopesToUpdate);
      return { mergeCount: 0, generalizeCount: 0, pruneCount: autoPruned, promotionCount, notes: "API returned no content." };
    }

    const parsed = JSON.parse(textBlock.text);
    const result = ConsolidationResponseSchema.parse(parsed);

    const consolResult = await applyConsolidation(store, memories, result, autoPruned, promotionCount);
    await updateConsolidationTimestamp(store, scopesToUpdate);
    return consolResult;
  } catch (error) {
    log("error", `Consolidation API call failed: ${error instanceof Error ? error.message : String(error)}`);
    await updateConsolidationTimestamp(store, scopesToUpdate);
    return { mergeCount: 0, generalizeCount: 0, pruneCount: autoPruned, promotionCount, notes: `API error, only auto-pruning applied. ${error instanceof Error ? error.message : ""}` };
  }
}

/**
 * Find groups of similar memories using embedding cosine similarity.
 * Replaces Haiku-based clustering — deterministic, fast, no API call.
 * Falls back to token overlap when embeddings aren't available.
 *
 * Scoped comparison: when lastConsolidation is provided, only compare pairs
 * where at least one memory is recent (created after last consolidation).
 * Old×old pairs were already compared in previous consolidation cycles.
 * This reduces O(n²) to O(n×r) where r = recent memory count.
 */
function findSimilarGroups(
  memories: Memory[],
  globalIndex: EmbeddingIndex,
  projectIndex: EmbeddingIndex,
  threshold: number = 0.8,
  lastConsolidation: string | null = null,
): string[][] {
  // Identify which memories are recent (need comparison)
  const cutoff = lastConsolidation ? new Date(lastConsolidation).getTime() : 0;
  const isRecent = (m: Memory) => new Date(m.created_at).getTime() > cutoff;

  // Build adjacency via pairwise similarity
  const adjacent = new Map<string, Set<string>>();

  for (let i = 0; i < memories.length; i++) {
    const mi = memories[i];
    const idxI = mi.scope === "global" ? globalIndex : projectIndex;
    const vecI = idxI[mi.id];
    if (!vecI) continue;

    const miRecent = isRecent(mi);
    const miRegister = registerOf(mi);

    for (let j = i + 1; j < memories.length; j++) {
      const mj = memories[j];

      // Skip old×old pairs — already compared in previous consolidation
      if (lastConsolidation && !miRecent && !isRecent(mj)) continue;
      // Registers never mix: a craft memory can't be a merge candidate for a
      // person/self memory no matter how similar the embeddings look
      if (registerOf(mj) !== miRegister) continue;

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
 *
 * Same scoped comparison as findSimilarGroups — skip old×old pairs.
 */
function findSimilarGroupsByTokens(
  memories: Memory[],
  threshold: number = 0.7,
  lastConsolidation: string | null = null,
): string[][] {
  const cutoff = lastConsolidation ? new Date(lastConsolidation).getTime() : 0;
  const tokenSets = memories.map((m) => ({
    id: m.id,
    tokens: tokenize(m.content),
    recent: new Date(m.created_at).getTime() > cutoff,
    register: registerOf(m),
  }));

  const adjacent = new Map<string, Set<string>>();

  for (let i = 0; i < tokenSets.length; i++) {
    for (let j = i + 1; j < tokenSets.length; j++) {
      // Skip old×old pairs — already compared in previous consolidation
      if (lastConsolidation && !tokenSets[i].recent && !tokenSets[j].recent) continue;
      // Registers never mix
      if (tokenSets[i].register !== tokenSets[j].register) continue;

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
  lastConsolidation: string | null,
  scopesToUpdate: Array<"global" | "project">,
): Promise<ConsolidationResult> {
  const memById = new Map(memories.map((m) => [m.id, m]));

  // Step 4a: Find similar memory groups (deterministic, no API call for clustering)
  // Scoped: only compare pairs where at least one memory is recent
  let groups: string[][];
  if (isEmbeddingEnabled()) {
    const paths = store.getEmbeddingPaths();
    const globalIndex = loadEmbeddingIndex(paths.global);
    const projectIndex = loadEmbeddingIndex(paths.project);
    groups = findSimilarGroups(memories, globalIndex, projectIndex, 0.8, lastConsolidation);
    log("info", `Two-pass: embedding similarity found ${groups.length} groups from ${memories.length} memories (scoped to recent)`);
  } else {
    groups = findSimilarGroupsByTokens(memories, 0.7, lastConsolidation);
    log("info", `Two-pass: token overlap found ${groups.length} groups from ${memories.length} memories (scoped to recent)`);
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
    await updateConsolidationTimestamp(store, scopesToUpdate);
    return { mergeCount: 0, generalizeCount: 0, pruneCount: autoPruned, promotionCount, notes: "No merge candidates identified." };
  }

  // Step 4b: Sonnet consolidation — batch groups to avoid output truncation.
  // Each batch gets at most MAX_BATCH_MEMORIES candidates so Sonnet can respond
  // within max_tokens. Groups are kept intact (never split across batches).
  const MAX_BATCH_MEMORIES = 20;
  const batches: string[][][] = [];
  let currentBatch: string[][] = [];
  let currentSize = 0;

  for (const group of groups) {
    const groupSize = group.filter((id) => memById.has(id)).length;
    if (currentSize + groupSize > MAX_BATCH_MEMORIES && currentBatch.length > 0) {
      batches.push(currentBatch);
      currentBatch = [];
      currentSize = 0;
    }
    currentBatch.push(group);
    currentSize += groupSize;
  }
  if (currentBatch.length > 0) batches.push(currentBatch);

  const totalCandidates = candidateIds.size;
  const standaloneCount = memories.length - totalCandidates;
  log("info", `Two-pass: ${totalCandidates} candidates in ${batches.length} batches (${standaloneCount} standalone skipped)`);

  let totalMerges = 0;
  let totalGeneralizations = 0;
  let totalPrunes = autoPruned;
  const allNotes: string[] = [];

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batchGroups = batches[batchIdx];
    const batchIds = new Set<string>();
    for (const group of batchGroups) {
      for (const id of group) {
        if (memById.has(id)) batchIds.add(id);
      }
    }
    const batchMemories = memories.filter((m) => batchIds.has(m.id));
    const memoriesText = formatMemoriesText(batchMemories);

    try {
      const response = await getClient().messages.create({
        model: config.consolidationModel,
        max_tokens: 8000,
        system: CONSOLIDATION_SYSTEM_PROMPT,
        messages: [{ role: "user", content: `MEMORY BANK (${batchMemories.length} candidates for consolidation, batch ${batchIdx + 1}/${batches.length}):\n\n${memoriesText}` }],
        output_config: {
          format: {
            type: "json_schema",
            schema: CONSOLIDATION_SCHEMA,
          },
        },
      });

      const textBlock = response.content.find((b) => b.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        log("warn", `Batch ${batchIdx + 1}: no text block in response`);
        continue;
      }

      const parsed = JSON.parse(textBlock.text);
      const result = ConsolidationResponseSchema.parse(parsed);

      const batchResult = await applyConsolidation(store, memories, result, 0, 0);
      totalMerges += batchResult.mergeCount;
      totalGeneralizations += batchResult.generalizeCount;
      totalPrunes += batchResult.pruneCount;
      if (result.notes) allNotes.push(result.notes);

      log("info", `Batch ${batchIdx + 1}/${batches.length}: ${batchResult.mergeCount} merges, ${batchResult.generalizeCount} generalizations, ${batchResult.pruneCount} prunes`);
    } catch (error) {
      log("error", `Batch ${batchIdx + 1} failed: ${error instanceof Error ? error.message : String(error)}`);
      // Continue with remaining batches — don't let one failure stop everything
    }
  }

  await updateConsolidationTimestamp(store, scopesToUpdate);
  const notes = allNotes.join("; ") + ` (two-pass: ${totalCandidates} candidates in ${batches.length} batches, ${standaloneCount} standalone skipped)`;
  return { mergeCount: totalMerges, generalizeCount: totalGeneralizations, pruneCount: totalPrunes, promotionCount, notes };
}

/**
 * Apply the consolidation result to the store.
 * Exported for tests — scope graduation and merge/prune mechanics live here.
 */
export async function applyConsolidation(
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
    // Protected memories are never merged away, even if the model suggests it
    const sourceIds = merge.ids.filter((id) => memById.has(id) && !memById.get(id)!.protected);
    if (sourceIds.length < 2) continue;

    // Hard invariant: merges never cross registers. A person/self memory being
    // absorbed into a craft memory (or vice versa) is the destruction class
    // this system exists to prevent — refuse regardless of what the model said.
    const registers = new Set(sourceIds.map((id) => registerOf(memById.get(id)!)));
    if (registers.size > 1) {
      log("warn", `Consolidation: refused cross-register merge (${[...registers].join("+")}: ${sourceIds.join(", ")})`);
      continue;
    }
    const mergeRegister = [...registers][0];

    // Find the oldest created_at and highest access_count among sources
    const sources = sourceIds.map((id) => memById.get(id)!);
    const oldestCreated = sources.reduce((oldest, m) =>
      m.created_at < oldest ? m.created_at : oldest,
      sources[0].created_at,
    );
    const totalAccess = sources.reduce((sum, m) => sum + m.access_count, 0);
    // Scope: model's promote-by-kind call wins; else global if any source is global
    const scope = merge.merged.scope
      ?? (sources.some((m) => m.scope === "global") ? "global" : sources[0].scope);

    const merged: Memory = {
      id: generateId(),
      content: merge.merged.content.slice(0, 400),
      scope,
      register: mergeRegister,
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

    // Never-destroy: merge sources go to the deep archive with a lineage
    // pointer to their consolidated successor, not to deletion
    await store.archiveMemories(
      sourceIds,
      Object.fromEntries(sourceIds.map((id) => [id, { merged_into: merged.id }])),
    );
    for (const id of sourceIds) {
      memById.delete(id);
    }

    newMemories.push(merged);
    mergeCount++;
  }

  // Apply prunes (only IDs that still exist, weren't already merged, and
  // aren't protected) — migrate to deep archive instead of deleting
  const pruneBatch: string[] = [];
  const pruneSignals: Memory["salience"][] = [];
  for (const id of result.prune_ids) {
    if (memById.has(id) && !memById.get(id)!.protected) {
      const pruned = memById.get(id)!;
      pruneBatch.push(id);
      pruneSignals.push(pruned.salience);
      memById.delete(id);
      pruneCount++;
    }
  }
  await recordSignals(store, "prune", pruneSignals);
  if (pruneBatch.length > 0) {
    await store.archiveMemories(pruneBatch);
  }

  // Create generalized memories
  for (const gen of result.generalize) {
    const genMemory: Memory = {
      id: generateId(),
      content: gen.content.slice(0, 400),
      scope: "global", // patterns are typically global
      register: registerOf({ tags: gen.tags, salience: gen.salience }),
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

  // Note: callers are responsible for updating consolidation timestamp
  // (single-pass calls it directly, two-pass calls it after all batches)

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
