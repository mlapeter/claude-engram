import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { calculateStrength } from "./strength.js";
import { log } from "./logger.js";
import type { Memory, Meta, TranscriptCursor } from "./types.js";
import { getDataDir, projectHash } from "./types.js";

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
 * Score how well query tokens match against target tokens.
 * Returns 0-1: fraction of query tokens that appear in (or are substrings of) target tokens.
 */
export function tokenOverlap(queryTokens: string[], targetTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  let matches = 0;
  for (const qt of queryTokens) {
    // Check if any target token contains the query token or vice versa
    if (targetTokens.some((tt) => tt.includes(qt) || qt.includes(tt))) {
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
  loadCursor(): Promise<TranscriptCursor>;
  saveCursor(cursor: TranscriptCursor): Promise<void>;
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

  function metaPath(scope: "global" | "project"): string {
    return join(scope === "global" ? globalDir : projectDir, "meta.json");
  }

  function cursorPath(): string {
    return join(projectDir, "cursor.json");
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

  const store: MemoryStore = {
    async load(scope) {
      return readJsonFile<Memory[]>(memoriesPath(scope), []);
    },

    async loadAll() {
      const global = await store.load("global");
      const project = await store.load("project");
      return [...global, ...project];
    },

    async save(scope, memories) {
      await withLock(memoriesPath(scope), async () => {
        writeJsonFile(memoriesPath(scope), memories);
      });
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
      }
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
      }
    },

    async update(id, updates) {
      for (const scope of ["global", "project"] as const) {
        const path = memoriesPath(scope);
        await withLock(path, async () => {
          const memories = readJsonFile<Memory[]>(path, []);
          const idx = memories.findIndex((m) => m.id === id);
          if (idx !== -1) {
            memories[idx] = { ...memories[idx], ...updates };
            writeJsonFile(path, memories);
          }
        });
      }
    },

    async search(query, limit = 10) {
      const all = await store.loadAll();
      const q = query.toLowerCase();

      // Phase 1: exact substring match (best signal)
      const exact = all.filter((m) => m.content.toLowerCase().includes(q));
      if (exact.length > 0) {
        return exact
          .sort((a, b) => calculateStrength(b) - calculateStrength(a))
          .slice(0, limit);
      }

      // Phase 2: token-based fuzzy matching
      const queryTokens = tokenize(q);
      if (queryTokens.length === 0) return [];

      const scored = all
        .map((m) => {
          const contentTokens = tokenize(m.content.toLowerCase());
          const tagTokens = m.tags.map((t) => t.toLowerCase());
          const allTargetTokens = [...contentTokens, ...tagTokens];
          const score = tokenOverlap(queryTokens, allTargetTokens);
          return { memory: m, score };
        })
        .filter((s) => s.score > 0)
        .sort((a, b) => {
          // Sort by (token_score * strength) descending
          const aRank = a.score * calculateStrength(a.memory);
          const bRank = b.score * calculateStrength(b.memory);
          return bRank - aRank;
        })
        .slice(0, limit)
        .map((s) => s.memory);

      return scored;
    },

    async searchByTag(tags, limit = 10) {
      const all = await store.loadAll();
      return all
        .filter((m) => m.tags.some((t) => tags.includes(t)))
        .sort((a, b) => calculateStrength(b) - calculateStrength(a))
        .slice(0, limit);
    },

    async getAboveThreshold(minStrength) {
      const all = await store.loadAll();
      return all
        .filter((m) => calculateStrength(m) >= minStrength)
        .sort((a, b) => calculateStrength(b) - calculateStrength(a));
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
      writeJsonFile(metaPath(scope), meta);
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

    async loadCursor() {
      return readJsonFile<TranscriptCursor>(cursorPath(), {
        byteOffset: 0,
        lastSessionId: "",
      });
    },

    async saveCursor(cursor) {
      writeJsonFile(cursorPath(), cursor);
    },
  };

  return store;
}
