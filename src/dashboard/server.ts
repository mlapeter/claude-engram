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

/** Load all deep-archived memories from all scopes/projects. */
function loadAllArchived(): Array<Memory & { _project: string }> {
  const all: Array<Memory & { _project: string }> = [];
  const globalArc = readJsonFile<Memory[]>(join(DATA_DIR, "global", "deep_archive.json"), []);
  for (const m of globalArc) all.push({ ...m, _project: "_global" });
  const projectsDir = join(DATA_DIR, "projects");
  if (existsSync(projectsDir)) {
    for (const hash of readdirSync(projectsDir)) {
      const arc = readJsonFile<Memory[]>(join(projectsDir, hash, "deep_archive.json"), []);
      for (const m of arc) all.push({ ...m, _project: hash });
    }
  }
  return all;
}

/** Percentile over a sorted-or-not numeric array (p in [0,100]). */
function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
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
const MIND_PATH = resolve(import.meta.dir, "mind.html");
const APP_PATH = resolve(import.meta.dir, "app.html");

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // Unified dashboard (tabs: overview / memories / mind / health)
    if (url.pathname === "/" || url.pathname === "/index.html") {
      try {
        const html = readFileSync(APP_PATH, "utf-8");
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      } catch {
        return new Response("Dashboard HTML not found", { status: 500 });
      }
    }

    // Classic dashboard — kept during the transition to the unified page
    if (url.pathname === "/classic") {
      try {
        const html = readFileSync(HTML_PATH, "utf-8");
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      } catch {
        return new Response("Dashboard HTML not found", { status: 500 });
      }
    }

    // v2 layout was promoted to /
    if (url.pathname === "/v2") {
      return Response.redirect("/", 302);
    }

    // The Mind view — identity documents + episodes (DESIGN-RECENTER.md)
    if (url.pathname === "/mind") {
      try {
        const html = readFileSync(MIND_PATH, "utf-8");
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      } catch {
        return new Response("Mind HTML not found", { status: 500 });
      }
    }

    // --- API routes ---

    // Identity documents (core, people, pending deltas)
    if (url.pathname === "/api/identity") {
      const dataDir = getDataDir();
      const identityDir = join(dataDir, "identity");
      const readIf = (p: string) => (existsSync(p) ? readFileSync(p, "utf-8") : null);
      const people: Array<{ name: string; content: string }> = [];
      const peopleDir = join(identityDir, "people");
      if (existsSync(peopleDir)) {
        for (const f of readdirSync(peopleDir).sort()) {
          if (f.endsWith(".md")) {
            people.push({ name: f.replace(/\.md$/, ""), content: readFileSync(join(peopleDir, f), "utf-8") });
          }
        }
      }
      // Pending = deltas.md plus any mid-rewrite claim file (deltas.processing.md
      // survives a consolidation killed before folding; it must not look like zero)
      const pendingParts = [
        readIf(join(identityDir, "deltas.md")),
        readIf(join(identityDir, "deltas.processing.md")),
      ].filter((s): s is string => !!s && s.trim().length > 0);
      return Response.json({
        core: readIf(join(identityDir, "core.md")),
        people,
        deltas: pendingParts.length > 0 ? pendingParts.join("\n\n") : null,
      });
    }

    // Episodes — first-person session memories, newest first
    if (url.pathname === "/api/episodes") {
      const episodesDir = join(getDataDir(), "episodes");
      const episodes: Array<{ file: string; content: string }> = [];
      if (existsSync(episodesDir)) {
        for (const f of readdirSync(episodesDir).sort().reverse()) {
          if (f.endsWith(".md")) {
            episodes.push({ file: f, content: readFileSync(join(episodesDir, f), "utf-8") });
          }
        }
      }
      return Response.json({ episodes });
    }

    // Event detail — the click-through: an event, its hook run's sibling
    // events, and the FULL memories that run stored (active or archived)
    if (url.pathname.startsWith("/api/event/")) {
      const id = Number.parseInt(url.pathname.slice("/api/event/".length), 10);
      const db = getDb();
      if (!db || !Number.isFinite(id)) return Response.json({ error: "not found" }, { status: 404 });
      try {
        const event = db.prepare("SELECT * FROM events WHERE id = ?").get(id) as Record<string, unknown> | null;
        if (!event) { db.close(); return Response.json({ error: "not found" }, { status: 404 }); }
        let runEvents: Array<Record<string, unknown>> = [];
        if (typeof event.session_id === "string" && event.session_id) {
          runEvents = db.prepare(
            "SELECT * FROM events WHERE session_id = ? AND event IN ('extract','dedup','episode_request','hook_stop') ORDER BY ts",
          ).all(event.session_id) as Array<Record<string, unknown>>;
        }
        db.close();

        const memIds = new Set(runEvents.map((r) => r.memory_id).filter(Boolean) as string[]);
        if (event.memory_id) memIds.add(event.memory_id as string);
        const active = loadAllMemories().filter((m) => memIds.has(m.id));
        const activeIds = new Set(active.map((m) => m.id));
        const archived = memIds.size > activeIds.size
          ? loadAllArchived().filter((m) => memIds.has(m.id) && !activeIds.has(m.id))
          : [];
        const foundIds = new Set([...active, ...archived].map((m) => m.id));
        const gone = [...memIds].filter((mid) => !foundIds.has(mid)); // merged or pruned since

        const withStrength = (m: Memory & { _project: string }, state: string) => ({
          ...m, _state: state, _strength: Math.round(calculateStrength(m) * 100) / 100,
        });
        return Response.json({
          event,
          runEvents,
          memories: [
            ...active.map((m) => withStrength(m, "active")),
            ...archived.map((m) => withStrength(m, "archived")),
          ],
          gone,
        });
      } catch {
        db.close();
        return Response.json({ error: "lookup failed" }, { status: 500 });
      }
    }

    // Identity history — backup snapshots (consolidation's judgment must be
    // inspectable: what did the rewrite change, and why)
    if (url.pathname === "/api/identity/history") {
      const backupsDir = join(getDataDir(), "identity", ".backups");
      const snaps: Array<{ stamp: string; files: string[] }> = [];
      if (existsSync(backupsDir)) {
        for (const d of readdirSync(backupsDir).sort().reverse()) {
          const dir = join(backupsDir, d);
          try {
            snaps.push({ stamp: d, files: readdirSync(dir).filter((f) => f.endsWith(".md")).sort() });
          } catch { /* not a dir */ }
        }
      }
      // Attach rewrite notes recorded at consolidation time (backup path lives in query)
      const notes: Record<string, { notes: string; ts: string; error: string | null }> = {};
      const db = getDb();
      if (db) {
        try {
          const rows = db.prepare(
            "SELECT ts, query, content_snippet, error FROM events WHERE event = 'identity_rewrite' ORDER BY ts DESC LIMIT 200",
          ).all() as Array<{ ts: string; query: string | null; content_snippet: string | null; error: string | null }>;
          for (const r of rows) {
            if (r.query) {
              const stamp = r.query.split("/").pop()!;
              notes[stamp] = { notes: r.content_snippet ?? "", ts: r.ts, error: r.error };
            }
          }
        } catch { /* older db */ }
        db.close();
      }
      return Response.json({ snapshots: snaps.map((s) => ({ ...s, rewrite: notes[s.stamp] ?? null })) });
    }

    // One identity backup snapshot's full contents (for before/after diff)
    if (url.pathname === "/api/identity/backup") {
      const stamp = url.searchParams.get("stamp") ?? "";
      if (!/^[\w.-]+$/.test(stamp)) return Response.json({ error: "bad stamp" }, { status: 400 });
      const dir = join(getDataDir(), "identity", ".backups", stamp);
      if (!existsSync(dir)) return Response.json({ error: "not found" }, { status: 404 });
      const files: Record<string, string> = {};
      for (const f of readdirSync(dir)) {
        if (f.endsWith(".md")) files[f] = readFileSync(join(dir, f), "utf-8");
      }
      return Response.json({ stamp, files });
    }

    // Hook health — is the plumbing working, and how fast?
    if (url.pathname === "/api/hook-health") {
      const db = getDb();
      if (!db) return Response.json({ hooks: [] });
      try {
        const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
        const rows = db.prepare(
          "SELECT event, ts, duration_ms, error, project FROM events WHERE event LIKE 'hook_%' AND ts >= ? ORDER BY ts DESC",
        ).all(cutoff) as Array<{ event: string; ts: string; duration_ms: number | null; error: string | null; project: string | null }>;
        db.close();

        const dayAgo = new Date(Date.now() - 86400000).toISOString();
        const byHook = new Map<string, typeof rows>();
        for (const r of rows) {
          if (!byHook.has(r.event)) byHook.set(r.event, []);
          byHook.get(r.event)!.push(r);
        }
        const hooks = [...byHook.entries()].map(([event, runs]) => {
          const durations = runs.map((r) => r.duration_ms).filter((d): d is number => d != null);
          const failures = runs.filter((r) => r.error != null);
          return {
            hook: event.replace(/^hook_/, ""),
            runs7d: runs.length,
            runs24h: runs.filter((r) => r.ts >= dayAgo).length,
            failures7d: failures.length,
            p50: percentile(durations, 50),
            p95: percentile(durations, 95),
            last: runs[0] ?? null,
            lastError: failures[0] ?? null,
            recent: runs.slice(0, 40).reverse().map((r) => ({ ts: r.ts, ms: r.duration_ms, err: r.error != null })),
          };
        });
        const errors = rows.filter((r) => r.error != null).slice(0, 20);
        return Response.json({ hooks, errors });
      } catch {
        db.close();
        return Response.json({ hooks: [], errors: [] });
      }
    }

    // Tail of engram.log — the "why" behind whatever the health panel shows
    if (url.pathname === "/api/log-tail") {
      const lines = Math.min(500, Number.parseInt(url.searchParams.get("lines") ?? "120", 10) || 120);
      const logPath = join(getDataDir(), "engram.log");
      if (!existsSync(logPath)) return Response.json({ lines: [] });
      const content = readFileSync(logPath, "utf-8");
      const tail = content.slice(-131072).split("\n").filter(Boolean); // last 128KB is plenty
      return Response.json({ lines: tail.slice(-lines) });
    }

    // Search across memories + episodes + identity — one box, three stores
    if (url.pathname === "/api/search") {
      const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
      if (q.length < 2) return Response.json({ memories: [], episodes: [], identity: [] });
      const terms = q.split(/\s+/).filter(Boolean);
      const matches = (text: string) => {
        const t = text.toLowerCase();
        return terms.every((term) => t.includes(term));
      };
      const excerpt = (text: string) => {
        const t = text.toLowerCase();
        const i = t.indexOf(terms[0]);
        const start = Math.max(0, i - 80);
        return (start > 0 ? "…" : "") + text.slice(start, i + 220) + "…";
      };

      const memories = loadAllMemories()
        .filter((m) => matches(m.content) || m.tags.some((t) => matches(t)))
        .map((m) => ({ ...m, _strength: Math.round(calculateStrength(m) * 100) / 100 }))
        .sort((a, b) => b._strength - a._strength)
        .slice(0, 25);

      const episodes: Array<{ file: string; excerpt: string }> = [];
      const episodesDir = join(getDataDir(), "episodes");
      if (existsSync(episodesDir)) {
        for (const f of readdirSync(episodesDir).sort().reverse()) {
          if (!f.endsWith(".md")) continue;
          const content = readFileSync(join(episodesDir, f), "utf-8");
          if (matches(content)) episodes.push({ file: f, excerpt: excerpt(content) });
          if (episodes.length >= 10) break;
        }
      }

      const identity: Array<{ doc: string; excerpt: string }> = [];
      const identityDir = join(getDataDir(), "identity");
      const idFiles: Array<[string, string]> = [];
      if (existsSync(join(identityDir, "core.md"))) idFiles.push(["core.md", join(identityDir, "core.md")]);
      const peopleDir = join(identityDir, "people");
      if (existsSync(peopleDir)) {
        for (const f of readdirSync(peopleDir).sort()) {
          if (f.endsWith(".md")) idFiles.push([`people/${f}`, join(peopleDir, f)]);
        }
      }
      for (const name of ["deltas.md", "deltas.processing.md"]) {
        if (existsSync(join(identityDir, name))) idFiles.push([name, join(identityDir, name)]);
      }
      for (const [doc, path] of idFiles) {
        const content = readFileSync(path, "utf-8");
        if (matches(content)) identity.push({ doc, excerpt: excerpt(content) });
      }

      return Response.json({ memories, episodes, identity });
    }

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
