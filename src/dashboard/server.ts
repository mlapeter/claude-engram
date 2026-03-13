#!/usr/bin/env bun
/**
 * engram dashboard — local-only web UI for memory system visibility.
 * Run: bun run src/dashboard/server.ts
 */

import { Database } from "bun:sqlite";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { getDataDir } from "../core/types.js";
import { calculateStrength } from "../core/strength.js";
import { rollupDailyStats, pruneOldEvents } from "../core/events.js";
import { createStore } from "../core/store.js";
import { runConsolidation } from "../core/consolidation.js";
import { reconcile, type ReconciliationPlan } from "../sync/reconcile.js";
import { applySync, exportV4AsV1, type SimilarResolution } from "../sync/apply.js";
import { isValidV1Backup, type V1Memory, type V1Backup } from "../sync/schema.js";
import type { Memory } from "../core/types.js";

const PORT = 3333;
const DATA_DIR = getDataDir();
const DB_PATH = join(DATA_DIR, "dashboard.db");

function readJsonFile<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

/** Load all memories from all scopes/projects. */
function loadAllMemories(): Array<Memory & { _project: string }> {
  const all: Array<Memory & { _project: string }> = [];

  // Global
  const globalPath = join(DATA_DIR, "global", "memories.json");
  const globalMems = readJsonFile<Memory[]>(globalPath, []);
  for (const m of globalMems) {
    all.push({ ...m, _project: "_global" });
  }

  // Projects
  const projectsDir = join(DATA_DIR, "projects");
  if (existsSync(projectsDir)) {
    for (const hash of readdirSync(projectsDir)) {
      const memPath = join(projectsDir, hash, "memories.json");
      const mems = readJsonFile<Memory[]>(memPath, []);
      for (const m of mems) {
        all.push({ ...m, _project: hash });
      }
    }
  }

  return all;
}

/** Map project hashes to names using event log. */
function getProjectNames(db: Database): Record<string, string> {
  const map: Record<string, string> = {};
  try {
    const rows = db.prepare(
      "SELECT DISTINCT project, project_hash FROM events WHERE project IS NOT NULL AND project_hash IS NOT NULL"
    ).all() as Array<{ project: string; project_hash: string }>;
    for (const r of rows) {
      map[r.project_hash] = r.project;
    }
  } catch { /* empty db */ }
  return map;
}

function getDb(): Database | null {
  if (!existsSync(DB_PATH)) return null;
  const db = new Database(DB_PATH, { readonly: true });
  db.exec("PRAGMA journal_mode=WAL");
  return db;
}

const HTML_PATH = resolve(import.meta.dir, "index.html");

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // Serve the dashboard HTML
    if (url.pathname === "/" || url.pathname === "/index.html") {
      try {
        const html = readFileSync(HTML_PATH, "utf-8");
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      } catch {
        return new Response("Dashboard HTML not found", { status: 500 });
      }
    }

    // --- API routes ---

    // Health overview
    if (url.pathname === "/api/health") {
      const all = loadAllMemories();
      const strengths = all.map((m) => calculateStrength(m));
      const now = Date.now();

      const strong = strengths.filter((s) => s >= 0.7).length;
      const stable = strengths.filter((s) => s >= 0.4 && s < 0.7).length;
      const fading = strengths.filter((s) => s >= 0.15 && s < 0.4).length;
      const decaying = strengths.filter((s) => s < 0.15).length;

      const globalCount = all.filter((m) => m.scope === "global").length;
      const projectCount = all.filter((m) => m.scope === "project").length;

      const avgStrength = strengths.length > 0
        ? strengths.reduce((a, b) => a + b, 0) / strengths.length
        : 0;

      // Age distribution
      const ages = all.map((m) => (now - new Date(m.created_at).getTime()) / 86400000);
      const avgAge = ages.length > 0 ? ages.reduce((a, b) => a + b, 0) / ages.length : 0;

      // Type distribution
      const episodic = all.filter((m) => (m.memory_type ?? "episodic") === "episodic").length;
      const semantic = all.filter((m) => m.memory_type === "semantic").length;

      return Response.json({
        total: all.length,
        global: globalCount,
        project: projectCount,
        strong,
        stable,
        fading,
        decaying,
        avgStrength: Math.round(avgStrength * 100) / 100,
        avgAge: Math.round(avgAge * 10) / 10,
        episodic,
        semantic,
        consolidated: all.filter((m) => m.consolidated).length,
        generalized: all.filter((m) => m.generalized).length,
      });
    }

    // Memory constellation data (scatter plot)
    if (url.pathname === "/api/constellation") {
      const all = loadAllMemories();
      const now = Date.now();
      const points = all.map((m) => ({
        id: m.id,
        age: Math.round((now - new Date(m.created_at).getTime()) / 86400000 * 10) / 10,
        strength: Math.round(calculateStrength(m) * 100) / 100,
        scope: m.scope,
        access_count: m.access_count,
        tags: m.tags,
        content: m.content.slice(0, 100),
        type: m.memory_type ?? "episodic",
        project: m._project,
      }));
      return Response.json(points);
    }

    // Salience radar (average across all memories)
    if (url.pathname === "/api/salience") {
      const all = loadAllMemories();
      if (all.length === 0) return Response.json({ novelty: 0, relevance: 0, emotional: 0, predictive: 0 });

      const avg = {
        novelty: 0,
        relevance: 0,
        emotional: 0,
        predictive: 0,
      };
      for (const m of all) {
        avg.novelty += Number(m.salience?.novelty) || 0;
        avg.relevance += Number(m.salience?.relevance) || 0;
        avg.emotional += Number(m.salience?.emotional) || 0;
        avg.predictive += Number(m.salience?.predictive) || 0;
      }
      const n = all.length;
      return Response.json({
        novelty: Math.round(avg.novelty / n * 100) / 100,
        relevance: Math.round(avg.relevance / n * 100) / 100,
        emotional: Math.round(avg.emotional / n * 100) / 100,
        predictive: Math.round(avg.predictive / n * 100) / 100,
      });
    }

    // Recent events
    if (url.pathname === "/api/events") {
      const db = getDb();
      if (!db) return Response.json([]);
      try {
        const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);
        const rows = db.prepare(
          "SELECT * FROM events ORDER BY ts DESC LIMIT ?"
        ).all(limit);
        db.close();
        return Response.json(rows);
      } catch {
        db.close();
        return Response.json([]);
      }
    }

    // Daily stats for trend charts
    if (url.pathname === "/api/trends") {
      const db = getDb();
      if (!db) return Response.json([]);
      try {
        // Rollup before serving
        const writeDb = new Database(DB_PATH);
        writeDb.exec("PRAGMA journal_mode=WAL");
        rollupDailyStats(writeDb);
        pruneOldEvents(writeDb);
        writeDb.close();

        const days = parseInt(url.searchParams.get("days") ?? "30", 10);
        const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
        const rows = db.prepare(
          "SELECT * FROM daily_stats WHERE date >= ? ORDER BY date"
        ).all(cutoff);
        db.close();
        return Response.json(rows);
      } catch {
        db.close();
        return Response.json([]);
      }
    }

    // Strength distribution histogram
    if (url.pathname === "/api/strength-distribution") {
      const all = loadAllMemories();
      const buckets = new Array(20).fill(0); // 0.00-0.05, 0.05-0.10, ..., 0.95-1.00
      for (const m of all) {
        const s = calculateStrength(m);
        const idx = Math.min(Math.floor(s * 20), 19);
        buckets[idx]++;
      }
      return Response.json(buckets.map((count, i) => ({
        range: `${(i * 0.05).toFixed(2)}-${((i + 1) * 0.05).toFixed(2)}`,
        count,
      })));
    }

    // Tag distribution
    if (url.pathname === "/api/tags") {
      const all = loadAllMemories();
      const tagCounts: Record<string, number> = {};
      for (const m of all) {
        for (const t of m.tags) {
          tagCounts[t] = (tagCounts[t] || 0) + 1;
        }
      }
      const sorted = Object.entries(tagCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([tag, count]) => ({ tag, count }));
      return Response.json(sorted);
    }

    // Project overview
    if (url.pathname === "/api/projects") {
      const all = loadAllMemories();
      const db = getDb();
      const nameMap = db ? getProjectNames(db) : {};
      db?.close();

      const projects: Record<string, { name: string; hash: string; count: number; avgStrength: number; scopes: { global: number; project: number } }> = {};

      for (const m of all) {
        const key = m._project;
        if (!projects[key]) {
          projects[key] = {
            name: nameMap[key] || (key === "_global" ? "Global" : key.slice(0, 8)),
            hash: key,
            count: 0,
            avgStrength: 0,
            scopes: { global: 0, project: 0 },
          };
        }
        projects[key].count++;
        projects[key].avgStrength += calculateStrength(m);
        projects[key].scopes[m.scope]++;
      }

      for (const p of Object.values(projects)) {
        p.avgStrength = p.count > 0 ? Math.round(p.avgStrength / p.count * 100) / 100 : 0;
      }

      return Response.json(Object.values(projects));
    }

    // --- Actions API ---

    // Run consolidation
    if (url.pathname === "/api/consolidate" && req.method === "POST") {
      const store = createStore(process.cwd());
      const before = (await store.loadAll()).length;
      const result = await runConsolidation(store);
      const after = (await store.loadAll()).length;

      return Response.json({
        before,
        after,
        merged: result.mergeCount,
        generalized: result.generalizeCount,
        pruned: result.pruneCount,
        promoted: result.promotionCount,
        notes: result.notes,
      });
    }

    // Manual backup + download
    if (url.pathname === "/api/backup" && req.method === "POST") {
      const store = createStore(process.cwd());
      const backupPath = await store.backup();
      const all = await store.loadAll();
      return Response.json({
        backupPath,
        memoryCount: all.length,
        timestamp: new Date().toISOString(),
      });
    }

    if (url.pathname === "/api/backup/download" && req.method === "GET") {
      const globalPath = join(DATA_DIR, "global", "memories.json");
      const globalMems = readJsonFile<Memory[]>(globalPath, []);

      // Include project memories from all projects
      const all: Memory[] = [...globalMems];
      const projectsDir = join(DATA_DIR, "projects");
      if (existsSync(projectsDir)) {
        for (const hash of readdirSync(projectsDir)) {
          const memPath = join(projectsDir, hash, "memories.json");
          const mems = readJsonFile<Memory[]>(memPath, []);
          all.push(...mems);
        }
      }

      const backup = JSON.stringify({ memories: all, exportedAt: Date.now(), version: "v4" }, null, 2);
      return new Response(backup, {
        headers: {
          "content-type": "application/json",
          "content-disposition": `attachment; filename="engram-backup-${new Date().toISOString().slice(0, 10)}.json"`,
        },
      });
    }

    // --- Sync API ---

    // Sync state (single-user, module-level)
    // Upload v1 backup
    if (url.pathname === "/api/sync/upload" && req.method === "POST") {
      try {
        const body = await req.json();
        if (!isValidV1Backup(body)) {
          return Response.json({ error: "Invalid v1 backup format — expected { memories: [...] }" }, { status: 400 });
        }
        syncState.v1Memories = (body as V1Backup).memories;
        syncState.plan = null;
        return Response.json({
          count: syncState.v1Memories.length,
          version: (body as V1Backup).version ?? "unknown",
          exportedAt: (body as V1Backup).exportedAt ? new Date((body as V1Backup).exportedAt!).toISOString() : null,
        });
      } catch (e) {
        return Response.json({ error: `Parse error: ${e}` }, { status: 400 });
      }
    }

    // Run reconciliation
    if (url.pathname === "/api/sync/reconcile" && req.method === "POST") {
      const v1Mems = syncState.v1Memories;
      if (!v1Mems) {
        return Response.json({ error: "No v1 backup uploaded. Upload first or use skip." }, { status: 400 });
      }

      const globalPath = join(DATA_DIR, "global", "memories.json");
      const v4Global = readJsonFile<Memory[]>(globalPath, []);

      const plan = await reconcile(v1Mems, v4Global);
      syncState.plan = plan;

      return Response.json({
        method: plan.method,
        newFromV1: plan.newFromV1.length,
        newFromV4: plan.newFromV4.length,
        similar: plan.similar.map((s) => ({
          v1Content: s.v1.content,
          v4Content: s.v4.content,
          similarity: Math.round(s.similarity * 100) / 100,
          suggestedContent: s.suggestedMerge.content,
        })),
        duplicates: plan.duplicates.length,
      });
    }

    // Apply sync (write to v4 store + return v1 export)
    if (url.pathname === "/api/sync/apply" && req.method === "POST") {
      const plan = syncState.plan;
      if (!plan) {
        return Response.json({ error: "No reconciliation plan. Run reconcile first." }, { status: 400 });
      }

      const body = await req.json() as { resolutions?: SimilarResolution[] };
      const resolutions = body.resolutions ?? plan.similar.map(() => ({ action: "keep-v4" as const }));

      const store = createStore(process.cwd());
      const result = await applySync(store, { plan, similarResolutions: resolutions });

      // Clear sync state
      syncState.v1Memories = null;
      syncState.plan = null;

      return Response.json({
        backupPath: result.backupPath,
        addedToV4: result.addedToV4,
        resolvedSimilar: result.resolvedSimilar,
        totalV4Global: result.totalV4Global,
        v1Export: result.v1Export,
      });
    }

    // Skip upload — just export v4 globals as v1 (with warning acknowledgment)
    if (url.pathname === "/api/sync/export-v1" && req.method === "GET") {
      const globalPath = join(DATA_DIR, "global", "memories.json");
      const v4Global = readJsonFile<Memory[]>(globalPath, []);
      const v1Export = exportV4AsV1(v4Global);
      return Response.json(v1Export);
    }

    // Reconcile with empty v1 (skip-upload path)
    if (url.pathname === "/api/sync/skip-upload" && req.method === "POST") {
      syncState.v1Memories = [];
      const globalPath = join(DATA_DIR, "global", "memories.json");
      const v4Global = readJsonFile<Memory[]>(globalPath, []);

      const plan = await reconcile([], v4Global);
      syncState.plan = plan;

      return Response.json({
        method: plan.method,
        newFromV1: 0,
        newFromV4: plan.newFromV4.length,
        similar: [],
        duplicates: 0,
      });
    }

    return new Response("Not found", { status: 404 });
  },
});

// Sync state — single-user, cleared after apply
const syncState: {
  v1Memories: V1Memory[] | null;
  plan: ReconciliationPlan | null;
} = {
  v1Memories: null,
  plan: null,
};

console.log(`\n  ⚡ engram dashboard running at http://localhost:${PORT}\n`);
console.log(`  Data: ${DATA_DIR}`);
console.log(`  DB:   ${existsSync(DB_PATH) ? DB_PATH : "(no events yet — enable with dashboard: true in config.json)"}\n`);
