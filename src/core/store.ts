import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { calculateStrength } from "./strength.js";
import { log } from "./logger.js";
import type { Memory, Meta, TranscriptCursor } from "./types.js";
import { getDataDir, projectHash } from "./types.js";
import { loadConfig } from "./config.js";
import {
  isEmbeddingEnabled,
  embedAndStore,
  removeFromIndex,
  vectorSearch,
  embed,
  cosineSimilarity,
  loadEmbeddingIndex,
} from "./embeddings.js";

/**
 * Tokenize a string into normalized words (lowercase, stripped of possessives/punctuation).
 * "Mike's kids" → ["mike", "kids"]
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['']s\b/g, "")  // strip possessives
    .split(/[^a-z0-9]+/)       // split on non-alphanumeric
    .filter((t) => t.length > 1); // drop single chars
}

/**
 * Two tokens match if they are equal, or one contains the other AND the
 * contained token is a real word stem (≥4 chars). The length guard is
 * load-bearing: without it "flathead" matches "the", "rafting" matches "in",
 * and "north" matches "or" — every English memory scores ~0.5 against any
 * multi-word query, and the noise drowns the honest relevance signal
 * (the 2026-07-14 river-trip recall miss).
 */
export function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.includes(short);
}

/**
 * Score how well query tokens match against target tokens.
 * Returns 0-1: fraction of query tokens that match a target token.
 */
export function tokenOverlap(queryTokens: string[], targetTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  let matches = 0;
  for (const qt of queryTokens) {
    if (targetTokens.some((tt) => tokensMatch(qt, tt))) {
      matches++;
    }
  }
  return matches / queryTokens.length;
}

export interface MemoryStore {
  load(scope: "global" | "project"): Promise<Memory[]>;
  loadAll(): Promise<Memory[]>;
  save(scope: "global" | "project", memories: Memory[]): Promise<void>;
  add(memories: Memory[]): Promise<void>;
  remove(id: string): Promise<void>;
  update(id: string, updates: Partial<Memory>): Promise<void>;
  search(query: string, limit?: number): Promise<Memory[]>;
  searchByTag(tags: string[], limit?: number): Promise<Memory[]>;
  getAboveThreshold(minStrength: number): Promise<Memory[]>;
  loadMeta(scope: "global" | "project"): Promise<Meta>;
  saveMeta(scope: "global" | "project", meta: Meta): Promise<void>;
  backup(): Promise<string>;
  /** Temporal contiguity: find memories formed in the same session */
  getTemporalSiblings(sessionId: string, excludeId: string, limit?: number): Promise<Memory[]>;
  /** Spreading activation: persist related-but-distinct edges from sleep.
   * Same-scope pairs only; symmetric; capped per memory (weakest evicted). */
  addAssociationEdges(pairs: Array<{ a: string; b: string; w: number }>): Promise<number>;
  /** Spreading activation: one-hop neighbors of a memory, strongest first */
  getAssociatedMemories(id: string, limit?: number): Promise<Array<{ memory: Memory; w: number }>>;
  /** Bounded dedup window: recent + current session + top strongest */
  getRecentAndStrong(sessionId: string, opts?: { recentHours?: number; topStrongest?: number; maxTotal?: number }): Promise<Memory[]>;
  loadCursor(): Promise<TranscriptCursor>;
  saveCursor(cursor: TranscriptCursor): Promise<void>;
  /** Check which new content strings are duplicates of existing memories */
  checkDuplicates(contents: string[], threshold?: number): Promise<Set<number>>;
  /** Cache a generated briefing for instant SessionStart */
  saveBriefingCache(briefing: string, memoryCount: number): Promise<void>;
  /** Load cached briefing (null if none exists) */
  loadBriefingCache(): Promise<{ briefing: string; generatedAt: string; memoryCount: number } | null>;
  /** Embedding paths for external use (consolidation) */
  getEmbeddingPaths(): { global: string; project: string };
  /** Deep archive: load all archived memories for a scope */
  loadArchive(scope: "global" | "project"): Promise<Memory[]>;
  /** Deep archive: migrate active memories to the archive (preserves them with archived flag).
   * Optional per-id annotations (e.g. merged_into) are stamped onto the archived copies. */
  archiveMemories(ids: string[], annotations?: Record<string, Partial<Memory>>): Promise<number>;
  /** Deep archive: append pre-built copies directly (e.g. pre-gist originals) without touching the active store */
  archiveCopies(memories: Memory[]): Promise<number>;
  /** Deep archive: reactivate an archived memory, moving it back to active store with refreshed access */
  reactivateMemory(id: string): Promise<Memory | null>;
  /** Deep archive: high-specificity search over archived memories only */
  deepRecall(query: string, opts?: { limit?: number; minSpecificity?: number }): Promise<Memory[]>;
}

const MAX_BACKUPS = 5;

async function withLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(filePath, {
      stale: 5000,
      retries: { retries: 3, minTimeout: 100, maxTimeout: 1000 },
    });
    return await fn();
  } finally {
    if (release) await release();
  }
}

function readJsonFile<T>(path: string, fallback: T): T {
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

export function createStore(projectCwd: string): MemoryStore {
  const dataDir = getDataDir();
  const hash = projectHash(projectCwd);
  const globalDir = join(dataDir, "global");
  const projectDir = join(dataDir, "projects", hash);
  const backupDir = join(dataDir, "backups");

  function ensureDataDir(): void {
    mkdirSync(globalDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(backupDir, { recursive: true });
  }

  function memoriesPath(scope: "global" | "project"): string {
    return join(scope === "global" ? globalDir : projectDir, "memories.json");
  }

  function embeddingsPath(scope: "global" | "project"): string {
    return join(scope === "global" ? globalDir : projectDir, "embeddings.json");
  }

  function metaPath(scope: "global" | "project"): string {
    return join(scope === "global" ? globalDir : projectDir, "meta.json");
  }

  function cursorPath(): string {
    return join(projectDir, "cursor.json");
  }

  function archivePath(scope: "global" | "project"): string {
    return join(scope === "global" ? globalDir : projectDir, "deep_archive.json");
  }

  function associationsPath(scope: "global" | "project"): string {
    return join(scope === "global" ? globalDir : projectDir, "associations.json");
  }

  // Spreading-activation edge map: memory id → strongest neighbors.
  // Plain JSON on purpose — sophistication lives in sleep, storage stays text.
  type EdgeMap = Record<string, Array<{ id: string; w: number }>>;
  const MAX_ASSOC_EDGES = 6;

  function insertEdge(edges: EdgeMap, from: string, to: string, w: number): void {
    const list = edges[from] ?? [];
    const existing = list.find((e) => e.id === to);
    if (existing) {
      existing.w = Math.max(existing.w, w);
    } else {
      list.push({ id: to, w });
    }
    list.sort((x, y) => y.w - x.w);
    edges[from] = list.slice(0, MAX_ASSOC_EDGES);
  }

  /** Drop every edge that touches an id that is no longer active. */
  async function purgeAssociationEdges(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    for (const scope of ["global", "project"] as const) {
      const path = associationsPath(scope);
      const edges = readJsonFile<EdgeMap>(path, {});
      let changed = false;
      for (const key of Object.keys(edges)) {
        if (idSet.has(key)) {
          delete edges[key];
          changed = true;
          continue;
        }
        const filtered = edges[key].filter((e) => !idSet.has(e.id));
        if (filtered.length !== edges[key].length) {
          edges[key] = filtered;
          changed = true;
        }
      }
      if (changed) {
        try { readFileSync(path); } catch { writeJsonFile(path, {}); } // lockfile needs the file to exist
        await withLock(path, async () => writeJsonFile(path, edges));
      }
    }
  }

  ensureDataDir();

  // Ensure files exist for proper-lockfile (it needs a real file to lock)
  for (const scope of ["global", "project"] as const) {
    const mp = memoriesPath(scope);
    try {
      readFileSync(mp);
    } catch {
      writeJsonFile(mp, []);
    }
  }

  // Request-scoped cache: avoids redundant JSON reads within a single MCP tool call
  let cachedAll: Memory[] | null = null;
  let cacheTime = 0;
  const CACHE_TTL_MS = 1000; // 1 second

  function invalidateCache() {
    cachedAll = null;
  }

  const store: MemoryStore = {
    async load(scope) {
      const memories = readJsonFile<Memory[]>(memoriesPath(scope), []);
      // Backward compat: default memory_type for pre-v5 memories
      return memories.map((m) => ({ ...m, memory_type: m.memory_type ?? "episodic" as const }));
    },

    async loadAll() {
      const now = Date.now();
      if (cachedAll && (now - cacheTime) < CACHE_TTL_MS) {
        return cachedAll;
      }
      const global = await store.load("global");
      const project = await store.load("project");
      cachedAll = [...global, ...project];
      cacheTime = now;
      return cachedAll;
    },

    async save(scope, memories) {
      await withLock(memoriesPath(scope), async () => {
        writeJsonFile(memoriesPath(scope), memories);
      });
      invalidateCache();
    },

    async add(memories) {
      const byScope = { global: [] as Memory[], project: [] as Memory[] };
      for (const m of memories) {
        byScope[m.scope].push(m);
      }

      for (const scope of ["global", "project"] as const) {
        if (byScope[scope].length === 0) continue;
        const path = memoriesPath(scope);
        await withLock(path, async () => {
          const existing = readJsonFile<Memory[]>(path, []);
          existing.push(...byScope[scope]);
          writeJsonFile(path, existing);
        });
        // Embed new memories (async, best-effort)
        await embedAndStore(byScope[scope], embeddingsPath(scope));
      }
      invalidateCache();
    },

    async remove(id) {
      for (const scope of ["global", "project"] as const) {
        const path = memoriesPath(scope);
        await withLock(path, async () => {
          const memories = readJsonFile<Memory[]>(path, []);
          const filtered = memories.filter((m) => m.id !== id);
          if (filtered.length !== memories.length) {
            writeJsonFile(path, filtered);
          }
        });
        await removeFromIndex([id], embeddingsPath(scope));
      }
      await purgeAssociationEdges([id]);
      invalidateCache();
    },

    async update(id, updates) {
      for (const scope of ["global", "project"] as const) {
        const path = memoriesPath(scope);
        let updated: Memory | null = null;
        await withLock(path, async () => {
          const memories = readJsonFile<Memory[]>(path, []);
          const idx = memories.findIndex((m) => m.id === id);
          if (idx !== -1) {
            memories[idx] = { ...memories[idx], ...updates };
            updated = memories[idx];
            writeJsonFile(path, memories);
          }
        });
        // Re-embed if content changed
        if (updated && updates.content !== undefined) {
          await embedAndStore([updated], embeddingsPath(scope));
        }
      }
      invalidateCache();
    },

    async search(query, limit = 10) {
      const all = await store.loadAll();
      const q = query.toLowerCase();

      // Phase 1: exact substring match (best signal)
      const exact = all.filter((m) => m.content.toLowerCase().includes(q));
      if (exact.length > 0) {
        const strengthMap = new Map(exact.map((m) => [m.id, calculateStrength(m)]));
        return exact
          .sort((a, b) => strengthMap.get(b.id)! - strengthMap.get(a.id)!)
          .slice(0, limit);
      }

      // Phase 2: token-based scoring for all memories
      const queryTokens = tokenize(q);
      const tokenScores = new Map<string, number>();
      if (queryTokens.length > 0) {
        for (const m of all) {
          const contentTokens = tokenize(m.content.toLowerCase());
          const tagTokens = m.tags.map((t) => t.toLowerCase());
          const allTargetTokens = [...contentTokens, ...tagTokens];
          const score = tokenOverlap(queryTokens, allTargetTokens);
          if (score > 0) tokenScores.set(m.id, score);
        }
      }

      // Phase 3: vector-based scoring (if embeddings enabled)
      let vecScores = new Map<string, number>();
      if (isEmbeddingEnabled()) {
        try {
          vecScores = await vectorSearch(
            query,
            all,
            embeddingsPath("global"),
            embeddingsPath("project"),
          );
        } catch (err) {
          log("warn", `Vector search failed, falling back to token-only: ${err}`);
        }
      }

      // Phase 4: hybrid ranking
      const config = loadConfig();
      const w = config.hybridVectorWeight;
      const candidateIds = new Set([...tokenScores.keys(), ...vecScores.keys()]);

      if (candidateIds.size === 0) return [];

      const memById = new Map(all.map((m) => [m.id, m]));
      const now = Date.now();
      const ranked = [...candidateIds]
        .map((id) => {
          const tScore = tokenScores.get(id);
          const vScore = vecScores.get(id);
          let hybridScore: number;
          if (tScore !== undefined && vScore !== undefined) {
            hybridScore = (1 - w) * tScore + w * vScore;
          } else if (tScore !== undefined) {
            hybridScore = tScore;
          } else {
            hybridScore = vScore!;
          }
          const memory = memById.get(id)!;
          const strength = calculateStrength(memory);
          // Strength gates spontaneous availability (briefing, associations),
          // not cued retrieval: a strong cue should always reach a live memory.
          // Compressed to [floor, 1] so the strongest memory outranks the
          // weakest by at most 1/floor — relevance stays the dominant signal
          // instead of a ~50-deep strength-1.0 oligarchy eating every query.
          const strengthFactor =
            config.recallStrengthFloor + (1 - config.recallStrengthFloor) * strength;
          // Recency boost, capped: freshness breaks ties among comparably
          // relevant memories; it must not carry an irrelevant one to the top
          const ageHours = (now - new Date(memory.created_at).getTime()) / 3_600_000;
          const recencyBoost = Math.min(1 + 1 / (1 + ageHours), config.recallRecencyCap);
          return { memory, rank: hybridScore * strengthFactor * recencyBoost };
        })
        .sort((a, b) => b.rank - a.rank)
        .slice(0, limit)
        .map((s) => s.memory);

      return ranked;
    },

    async searchByTag(tags, limit = 10) {
      const all = await store.loadAll();
      const matched = all.filter((m) => m.tags.some((t) => tags.includes(t)));
      const strengthMap = new Map(matched.map((m) => [m.id, calculateStrength(m)]));
      return matched
        .sort((a, b) => strengthMap.get(b.id)! - strengthMap.get(a.id)!)
        .slice(0, limit);
    },

    async getAboveThreshold(minStrength) {
      const all = await store.loadAll();
      const withStrength = all.map((m) => ({ memory: m, strength: calculateStrength(m) }));
      return withStrength
        .filter((s) => s.strength >= minStrength)
        .sort((a, b) => b.strength - a.strength)
        .map((s) => s.memory);
    },

    async loadMeta(scope) {
      const path = metaPath(scope);
      return readJsonFile<Meta>(path, {
        lastConsolidation: null,
        created: new Date().toISOString(),
        sessionCount: 0,
      });
    },

    async saveMeta(scope, meta) {
      const path = metaPath(scope);
      // Ensure file exists for proper-lockfile
      try { readFileSync(path); } catch { writeJsonFile(path, {}); }
      await withLock(path, async () => {
        writeJsonFile(path, meta);
      });
    },

    async backup() {
      const ts = new Date().toISOString().replace(/:/g, "-");
      const backupFile = join(backupDir, `memories-${ts}.json`);
      const all = await store.loadAll();
      writeJsonFile(backupFile, all);

      // Prune old backups
      const files = readdirSync(backupDir)
        .filter((f) => f.startsWith("memories-"))
        .sort()
        .reverse();
      for (const old of files.slice(MAX_BACKUPS)) {
        try {
          unlinkSync(join(backupDir, old));
        } catch {
          log("warn", `Failed to delete old backup: ${old}`);
        }
      }

      return backupFile;
    },

    async getTemporalSiblings(sessionId, excludeId, limit = 3) {
      // Synthetic sessions don't form real temporal associations
      const SYNTHETIC_SESSIONS = ["mcp-store", "consolidation"];
      if (SYNTHETIC_SESSIONS.includes(sessionId)) return [];

      const all = await store.loadAll();
      const siblings = all.filter((m) => m.source_session === sessionId && m.id !== excludeId);
      const strengthMap = new Map(siblings.map((m) => [m.id, calculateStrength(m)]));
      return siblings
        .sort((a, b) => strengthMap.get(b.id)! - strengthMap.get(a.id)!)
        .slice(0, limit);
    },

    async addAssociationEdges(pairs) {
      if (pairs.length === 0) return 0;
      let written = 0;
      for (const scope of ["global", "project"] as const) {
        const activeIds = new Set((await store.load(scope)).map((m) => m.id));
        const scopePairs = pairs.filter((p) => activeIds.has(p.a) && activeIds.has(p.b) && p.a !== p.b);
        if (scopePairs.length === 0) continue;
        const path = associationsPath(scope);
        try { readFileSync(path); } catch { writeJsonFile(path, {}); } // lockfile needs the file to exist
        await withLock(path, async () => {
          const edges = readJsonFile<EdgeMap>(path, {});
          for (const { a, b, w } of scopePairs) {
            insertEdge(edges, a, b, w);
            insertEdge(edges, b, a, w);
            written++;
          }
          writeJsonFile(path, edges);
        });
      }
      return written;
    },

    async getAssociatedMemories(id, limit = MAX_ASSOC_EDGES) {
      const out: Array<{ memory: Memory; w: number }> = [];
      const all = await store.loadAll();
      const byId = new Map(all.map((m) => [m.id, m]));
      for (const scope of ["global", "project"] as const) {
        const edges = readJsonFile<EdgeMap>(associationsPath(scope), {});
        for (const e of edges[id] ?? []) {
          const memory = byId.get(e.id);
          if (memory) out.push({ memory, w: e.w }); // archived endpoints are purged at write; skip stragglers
        }
      }
      return out.sort((x, y) => y.w - x.w).slice(0, limit);
    },

    async getRecentAndStrong(sessionId, opts = {}) {
      const { recentHours = 48, topStrongest = 30, maxTotal = 100 } = opts;
      const all = await store.loadAll();
      const cutoff = Date.now() - recentHours * 3600_000;

      const seen = new Set<string>();
      const result: Memory[] = [];

      // 1. Current session memories (avoid intra-session duplicates)
      for (const m of all) {
        if (m.source_session === sessionId) {
          seen.add(m.id);
          result.push(m);
        }
      }

      // 2. Recent memories (last recentHours)
      for (const m of all) {
        if (seen.has(m.id)) continue;
        if (new Date(m.created_at).getTime() >= cutoff) {
          seen.add(m.id);
          result.push(m);
        }
      }

      // 3. Top strongest (long-lived important facts)
      const unseen = all.filter((m) => !seen.has(m.id));
      const strengthMap = new Map(unseen.map((m) => [m.id, calculateStrength(m)]));
      const byStrength = unseen
        .sort((a, b) => strengthMap.get(b.id)! - strengthMap.get(a.id)!)
        .slice(0, topStrongest);
      for (const m of byStrength) {
        seen.add(m.id);
        result.push(m);
      }

      // Cap at maxTotal
      return result.slice(0, maxTotal);
    },

    async loadCursor() {
      return readJsonFile<TranscriptCursor>(cursorPath(), {
        byteOffset: 0,
        lastSessionId: "",
      });
    },

    async saveCursor(cursor) {
      writeJsonFile(cursorPath(), cursor);
    },

    async checkDuplicates(contents, threshold = 0.85) {
      const duplicates = new Set<number>();
      if (contents.length === 0) return duplicates;

      if (isEmbeddingEnabled()) {
        // Embedding-based dedup: one API call for all new contents
        const newVecs = await embed(contents);
        if (newVecs.length !== contents.length) return duplicates; // API failure, skip dedup

        const globalIndex = loadEmbeddingIndex(embeddingsPath("global"));
        const projectIndex = loadEmbeddingIndex(embeddingsPath("project"));
        const allVecs = { ...globalIndex, ...projectIndex };

        for (let i = 0; i < newVecs.length; i++) {
          for (const existingVec of Object.values(allVecs)) {
            if (cosineSimilarity(newVecs[i], existingVec) >= threshold) {
              duplicates.add(i);
              break;
            }
          }
          if (duplicates.has(i)) continue;
          // Within-batch dedup: chunked extraction can emit the same fact from
          // two chunks of one arc — keep the first occurrence, mark the rest.
          for (let j = 0; j < i; j++) {
            if (duplicates.has(j)) continue;
            if (cosineSimilarity(newVecs[i], newVecs[j]) >= threshold) {
              duplicates.add(i);
              break;
            }
          }
        }
      } else {
        // Token overlap fallback
        const all = await store.loadAll();
        const existingTokenSets = all.map((m) => tokenize(m.content));
        const newTokenSets = contents.map(tokenize);

        for (let i = 0; i < contents.length; i++) {
          const newTokens = newTokenSets[i];
          for (const et of existingTokenSets) {
            if (tokenOverlap(newTokens, et) > 0.8) {
              duplicates.add(i);
              break;
            }
          }
          if (duplicates.has(i)) continue;
          // Within-batch dedup (see embedding branch above).
          for (let j = 0; j < i; j++) {
            if (duplicates.has(j)) continue;
            if (tokenOverlap(newTokens, newTokenSets[j]) > 0.8) {
              duplicates.add(i);
              break;
            }
          }
        }
      }

      return duplicates;
    },

    async saveBriefingCache(briefing, memoryCount) {
      const cachePath = join(projectDir, "briefing-cache.json");
      writeJsonFile(cachePath, {
        briefing,
        generatedAt: new Date().toISOString(),
        memoryCount,
      });
    },

    async loadBriefingCache() {
      const cachePath = join(projectDir, "briefing-cache.json");
      const data = readJsonFile<{ briefing: string; generatedAt: string; memoryCount: number } | null>(cachePath, null);
      return data;
    },

    getEmbeddingPaths() {
      return {
        global: embeddingsPath("global"),
        project: embeddingsPath("project"),
      };
    },

    async loadArchive(scope) {
      return readJsonFile<Memory[]>(archivePath(scope), []);
    },

    async archiveMemories(ids, annotations) {
      if (ids.length === 0) return 0;
      const idSet = new Set(ids);
      const now = new Date().toISOString();
      let total = 0;

      for (const scope of ["global", "project"] as const) {
        const memPath = memoriesPath(scope);
        const archPath = archivePath(scope);

        // Ensure archive file exists for locking
        try { readFileSync(archPath); } catch { writeJsonFile(archPath, []); }

        const archivedHere: Memory[] = [];
        await withLock(memPath, async () => {
          const memories = readJsonFile<Memory[]>(memPath, []);
          const remaining: Memory[] = [];
          for (const m of memories) {
            if (idSet.has(m.id)) {
              archivedHere.push({ ...m, ...(annotations?.[m.id] ?? {}), archived: true, archived_at: now });
            } else {
              remaining.push(m);
            }
          }
          if (archivedHere.length > 0) {
            writeJsonFile(memPath, remaining);
          }
        });

        if (archivedHere.length > 0) {
          await withLock(archPath, async () => {
            const existing = readJsonFile<Memory[]>(archPath, []);
            writeJsonFile(archPath, [...existing, ...archivedHere]);
          });
          total += archivedHere.length;
          log("info", `Archive: migrated ${archivedHere.length} memories to ${scope} deep archive`);
        }
      }

      // Association edges die with their endpoints — an edge into the archive
      // would resurface as a dangling neighbor at recall time
      await purgeAssociationEdges(ids);
      invalidateCache();
      return total;
    },

    async archiveCopies(memories) {
      if (memories.length === 0) return 0;
      const now = new Date().toISOString();
      let total = 0;
      for (const scope of ["global", "project"] as const) {
        const copies = memories
          .filter((m) => m.scope === scope)
          .map((m) => ({ ...m, archived: true, archived_at: m.archived_at ?? now }));
        if (copies.length === 0) continue;
        const archPath = archivePath(scope);
        try { readFileSync(archPath); } catch { writeJsonFile(archPath, []); }
        await withLock(archPath, async () => {
          const existing = readJsonFile<Memory[]>(archPath, []);
          writeJsonFile(archPath, [...existing, ...copies]);
        });
        total += copies.length;
      }
      return total;
    },

    async reactivateMemory(id) {
      for (const scope of ["global", "project"] as const) {
        const archPath = archivePath(scope);
        let reactivated: Memory | null = null;

        try { readFileSync(archPath); } catch { continue; }

        await withLock(archPath, async () => {
          const archive = readJsonFile<Memory[]>(archPath, []);
          const idx = archive.findIndex((m) => m.id === id);
          if (idx === -1) return;

          reactivated = {
            ...archive[idx],
            archived: false,
            archived_at: null,
            last_accessed: new Date().toISOString(),
            access_count: archive[idx].access_count + 1,
          };

          const newArchive = archive.filter((m) => m.id !== id);
          writeJsonFile(archPath, newArchive);
        });

        if (reactivated) {
          const memPath = memoriesPath(scope);
          await withLock(memPath, async () => {
            const memories = readJsonFile<Memory[]>(memPath, []);
            memories.push(reactivated!);
            writeJsonFile(memPath, memories);
          });
          invalidateCache();
          log("info", `Archive: reactivated ${id} from ${scope} deep archive`);
          return reactivated;
        }
      }
      return null;
    },

    async deepRecall(query, opts = {}) {
      const { limit = 5, minSpecificity = 0.5 } = opts;
      const all: Memory[] = [];
      for (const scope of ["global", "project"] as const) {
        all.push(...(await store.loadArchive(scope)));
      }
      if (all.length === 0) return [];

      const q = query.toLowerCase();

      // High-specificity matching: prefer exact substring; require strong token overlap otherwise
      type Scored = { memory: Memory; score: number };
      const exact: Scored[] = [];
      const fuzzy: Scored[] = [];

      const queryTokens = tokenize(q);
      for (const m of all) {
        const content = m.content.toLowerCase();
        if (content.includes(q)) {
          exact.push({ memory: m, score: 1.0 });
          continue;
        }
        if (queryTokens.length === 0) continue;
        const memTokens = tokenize(content);
        const overlap = tokenOverlap(queryTokens, memTokens);
        if (overlap >= minSpecificity) {
          fuzzy.push({ memory: m, score: overlap });
        }
      }

      const candidates = exact.length > 0 ? exact : fuzzy;
      return candidates
        .sort((a, b) => {
          const sA = calculateStrength(a.memory) * a.score;
          const sB = calculateStrength(b.memory) * b.score;
          return sB - sA;
        })
        .slice(0, limit)
        .map((s) => s.memory);
    },
  };

  return store;
}
