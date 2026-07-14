#!/usr/bin/env bun
/**
 * claude-engram MCP server.
 * Exposes memory tools to Claude Code as mcp__engram__<tool>.
 *
 * IMPORTANT: Never use console.log() — it corrupts the stdio protocol.
 * Use console.error() or the file logger for diagnostics.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createStore, type MemoryStore } from "../core/store.js";
import { calculateStrength } from "../core/strength.js";
import { generateId, sanitizeSalience, scopeFromTags, getDataDir, projectHash } from "../core/types.js";
import type { Memory } from "../core/types.js";
import { log } from "../core/logger.js";
import { isObserverMode } from "../core/config.js";
import { getCurrentActiveDay } from "../core/active-day.js";
import { runConsolidation } from "../core/consolidation.js";
import { recordSignal } from "../core/salience-weights.js";
import { recordEvent, recordIdentityRewrite } from "../core/events.js";
import { basename } from "node:path";

const projectName = basename(process.cwd());
const projHash = projectHash(process.cwd());

// --- Store initialization ---
// MCP server uses process.cwd() for project scoping — Claude Code launches
// the server from the project directory.
const store = createStore(process.cwd());

// --- Server setup ---
const server = new McpServer({
  name: "engram",
  version: "0.4.0",
});

// --- Tool: status ---
server.registerTool("status", {
  title: "Memory Status",
  description: "Get a health overview of my memory bank. Shows total count, average strength, consolidation status.",
  annotations: { readOnlyHint: true },
}, async () => {
  const globalMems = await store.load("global");
  const projectMems = await store.load("project");
  const all = [...globalMems, ...projectMems];

  const strengths = all.map(calculateStrength);
  const avg = strengths.length > 0 ? strengths.reduce((a, b) => a + b, 0) / strengths.length : 0;

  const globalStrengths = globalMems.map(calculateStrength);
  const projectStrengths = projectMems.map(calculateStrength);
  const avgGlobal = globalStrengths.length > 0 ? globalStrengths.reduce((a, b) => a + b, 0) / globalStrengths.length : 0;
  const avgProject = projectStrengths.length > 0 ? projectStrengths.reduce((a, b) => a + b, 0) / projectStrengths.length : 0;

  const globalMeta = await store.loadMeta("global");
  const projectMeta = await store.loadMeta("project");
  // Pick the most recent consolidation timestamp across scopes
  const lastConsol = [globalMeta.lastConsolidation, projectMeta.lastConsolidation]
    .filter(Boolean)
    .sort()
    .pop() ?? null;
  const daysSinceConsol = lastConsol
    ? (Date.now() - new Date(lastConsol).getTime()) / 86400000
    : null;

  const status = {
    global: { total: globalMems.length, avg_strength: round(avgGlobal) },
    project: { total: projectMems.length, avg_strength: round(avgProject) },
    combined: {
      total: all.length,
      avg_strength: round(avg),
      strong: strengths.filter((s) => s >= 0.7).length,
      stable: strengths.filter((s) => s >= 0.4 && s < 0.7).length,
      fading: strengths.filter((s) => s >= 0.15 && s < 0.4).length,
      decaying: strengths.filter((s) => s < 0.15).length,
      consolidated: all.filter((m) => m.consolidated).length,
      patterns: all.filter((m) => m.generalized).length,
    },
    last_consolidation: lastConsol,
    days_since_consolidation: daysSinceConsol !== null ? round(daysSinceConsol) : null,
    storage_path: getDataDir(),
  };

  return { content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }] };
});

// --- Tool: recall ---
server.registerTool("recall", {
  title: "Recall Memories",
  description: "Search my memories by text query. Returns matching memories ranked by relevance x strength. Use when a topic comes up that I might have relevant memories about.",
  inputSchema: {
    query: z.string().describe("Search query"),
    limit: z.number().optional().default(5).describe("Max results"),
    min_strength: z.number().optional().default(0.1).describe("Minimum strength threshold"),
  },
}, async ({ query, limit, min_strength }) => {
  const results = await store.search(query, limit! + 10); // over-fetch to filter
  const filtered = results.filter((m) => calculateStrength(m) >= min_strength!).slice(0, limit);

  // Hebbian reinforcement: accessed memories get stronger — unless we're in
  // observer mode (developing/testing the memory system itself must not
  // over-strengthen whatever memories we keep handling)
  if (!isObserverMode()) {
    for (const m of filtered) {
      await store.update(m.id, {
        access_count: m.access_count + 1,
        last_accessed: new Date().toISOString(),
      });
    }
  }

  const output = filtered.map((m) => ({
    id: m.id,
    content: m.content,
    scope: m.scope,
    memory_type: m.memory_type ?? "episodic",
    tags: m.tags,
    strength: round(calculateStrength(m)),
    created_at: m.created_at,
    // Compression must stay reachable, not just archived: a consolidated
    // memory is a lossy merge — flag it so a strong cue knows to dig deeper
    ...(m.consolidated ? { consolidated: true as const, note: "compressed merge — deep_recall can recover the verbatim originals" } : {}),
  }));

  // Spreading activation (one hop): semantic edges written by sleep come
  // first — they carry the model's related-but-distinct judgment. Temporal
  // contiguity (same-session siblings) fills the remaining budget.
  const directIds = new Set(filtered.map((m) => m.id));
  const associations: Array<{ id: string; content: string; strength: number; associated_with: string; association_type: string }> = [];
  for (const m of filtered) {
    if (associations.length >= 6) break;
    const linked = await store.getAssociatedMemories(m.id, 2);
    for (const { memory: s } of linked) {
      if (directIds.has(s.id)) continue;
      if (associations.some((a) => a.id === s.id)) continue;
      if (associations.length >= 6) break;
      associations.push({
        id: s.id,
        content: s.content,
        strength: round(calculateStrength(s)),
        associated_with: m.id,
        association_type: "semantic",
      });
    }
  }
  for (const m of filtered) {
    if (associations.length >= 6) break;
    const siblings = await store.getTemporalSiblings(m.source_session, m.id, 2);
    for (const s of siblings) {
      if (directIds.has(s.id)) continue;
      if (associations.some((a) => a.id === s.id)) continue;
      if (associations.length >= 6) break;
      associations.push({
        id: s.id,
        content: s.content,
        strength: round(calculateStrength(s)),
        associated_with: m.id,
        association_type: "temporal",
      });
    }
  }

  const result = associations.length > 0 ? { memories: output, associations } : output;
  log("info", `MCP recall: "${query}" → ${output.length} results, ${associations.length} associations`);
  recordEvent({ event: "recall", project: projectName, project_hash: projHash, query, count: output.length });
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
});

// --- Tool: search_by_tag ---
server.registerTool("search_by_tag", {
  title: "Search by Tag",
  description: "Search my memories by tag. Use for pulling up everything I remember about a topic, project, or person. Tags: identity, goal, preference, project, relationship, skill, insight, contradiction, pattern, context, technical, personal, business, creative.",
  inputSchema: {
    tags: z.array(z.string()).describe("Tags to search for (OR logic)"),
    limit: z.number().optional().default(10).describe("Max results"),
  },
}, async ({ tags, limit }) => {
  const results = await store.searchByTag(tags, limit);

  // Hebbian reinforcement — skipped in observer mode
  if (!isObserverMode()) {
    for (const m of results) {
      await store.update(m.id, {
        access_count: m.access_count + 1,
        last_accessed: new Date().toISOString(),
      });
    }
  }

  const output = results.map((m) => ({
    id: m.id,
    content: m.content,
    scope: m.scope,
    memory_type: m.memory_type ?? "episodic",
    tags: m.tags,
    strength: round(calculateStrength(m)),
    created_at: m.created_at,
  }));

  // Temporal contiguity: gather associated memories formed in the same session
  const directIds = new Set(results.map((m) => m.id));
  const associations: Array<{ id: string; content: string; strength: number; associated_with: string; association_type: string }> = [];
  for (const m of results) {
    if (associations.length >= 6) break;
    const siblings = await store.getTemporalSiblings(m.source_session, m.id, 2);
    for (const s of siblings) {
      if (directIds.has(s.id)) continue;
      if (associations.some((a) => a.id === s.id)) continue;
      if (associations.length >= 6) break;
      associations.push({
        id: s.id,
        content: s.content,
        strength: round(calculateStrength(s)),
        associated_with: m.id,
        association_type: "temporal",
      });
    }
  }

  const result = associations.length > 0 ? { memories: output, associations } : output;
  log("info", `MCP search_by_tag: [${tags.join(", ")}] → ${output.length} results, ${associations.length} associations`);
  recordEvent({ event: "recall", project: projectName, project_hash: projHash, query: `tag:${tags.join(",")}`, count: output.length, tags });
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
});

// --- Tool: reinforce ---
server.registerTool("reinforce", {
  title: "Reinforce Memory",
  description: "Strengthen a memory that proved relevant or useful. Like Hebbian learning — memories I access get stronger. Optionally update the memory's content (reconsolidation) — use this when a memory is mostly right but needs correction or refinement.",
  inputSchema: {
    memory_id: z.string().describe("ID of the memory to reinforce"),
    new_content: z.string().max(400).optional().describe("Updated content to replace the existing memory text. Only use when the memory needs correction — leave empty to just strengthen."),
  },
}, async ({ memory_id, new_content }) => {
  const all = await store.loadAll();
  const mem = all.find((m) => m.id === memory_id);
  if (!mem) {
    return { content: [{ type: "text" as const, text: `Memory ${memory_id} not found.` }], isError: true };
  }

  const updates: Partial<Memory> = {
    access_count: mem.access_count + 1,
    last_accessed: new Date().toISOString(),
  };

  let action = "Reinforced";
  if (new_content && new_content.trim() !== mem.content) {
    log("info", `MCP reinforce/reconsolidate: ${memory_id} old content: "${mem.content}"`);
    updates.content = new_content.slice(0, 400);
    action = "Reconsolidated";
  }

  await store.update(memory_id, updates);
  await recordSignal(store, "reinforce", mem.salience);

  const newStrength = calculateStrength({ ...mem, access_count: mem.access_count + 1 });
  log("info", `MCP reinforce: ${memory_id} → strength ${round(newStrength)}${new_content ? " (content updated)" : ""}`);
  recordEvent({ event: "reinforce", project: projectName, project_hash: projHash, memory_id, strength: round(newStrength), content_snippet: mem.content.slice(0, 80) });
  return {
    content: [{
      type: "text" as const,
      text: `${action} "${(new_content || mem.content).slice(0, 60)}..." — strength: ${round(newStrength)}`,
    }],
  };
});

// --- Tool: protect ---
server.registerTool("protect", {
  title: "Protect Memory (Sacred Verbatim)",
  description: "Mark a memory as sacred-verbatim: it will never be merged away, pruned, gist-compressed, or weakened by interference. Its exact words persist. Use sparingly — for memories whose specific wording matters (standing intentions, moments that shouldn't be summarized). Forgetting is a feature; protection is for the exceptions.",
  inputSchema: {
    memory_id: z.string().describe("ID of the memory to protect"),
    unprotect: z.boolean().optional().default(false).describe("Set true to remove protection instead"),
  },
}, async ({ memory_id, unprotect }) => {
  const all = await store.loadAll();
  const mem = all.find((m) => m.id === memory_id);
  if (!mem) {
    return { content: [{ type: "text" as const, text: `Memory ${memory_id} not found.` }], isError: true };
  }
  await store.update(memory_id, { protected: !unprotect });
  log("info", `MCP protect: ${memory_id} protected=${!unprotect} — "${mem.content.slice(0, 60)}"`);
  recordEvent({ event: "protect", project: projectName, project_hash: projHash, memory_id, content_snippet: mem.content.slice(0, 80), count: unprotect ? 0 : 1 });
  return {
    content: [{
      type: "text" as const,
      text: `${unprotect ? "Unprotected" : "Protected (sacred-verbatim)"}: "${mem.content.slice(0, 80)}..."`,
    }],
  };
});

// --- Tool: store ---
server.registerTool("store", {
  title: "Store Memory",
  description: "Immediately store an important memory. Use when something significant happens that I want to remember — major decisions, surprising realizations, meaningful moments. IMPORTANT: Content must be ≤400 characters. Compress to the essential gist — like how you'd remember it, not how you'd explain it. Drop filler words, use shorthand, keep only what matters for future recall. If your first draft is too long, compress it yourself before calling this tool.",
  inputSchema: {
    content: z.string().max(400).describe("Memory content — must be ≤400 chars. Compress to essential gist: key facts, names, decisions. Drop articles, filler, and details that can be re-derived from context."),
    tags: z.array(z.string()).optional().default(["insight"]).describe("1-5 tags"),
    salience_hint: z.enum(["low", "medium", "high", "critical"]).optional().default("medium").describe("Importance level"),
    scope: z.enum(["global", "project"]).optional().describe("Memory scope. Global memories are visible across all projects — use for personal facts, relationships, decisions, realizations, and anything you'd want to remember in a different project. Project memories are only visible in this project — use for implementation details specific to this codebase. When in doubt, prefer global. Defaults to auto-detect from tags."),
  },
}, async ({ content, tags, salience_hint, scope: explicitScope }) => {
  const hintMap: Record<string, number> = { low: 0.3, medium: 0.5, high: 0.7, critical: 0.9 };
  const score = hintMap[salience_hint!] ?? 0.5;
  const scope = explicitScope ?? scopeFromTags(tags!);

  const memory: Memory = {
    id: generateId(),
    content: content.slice(0, 400),
    scope,
    memory_type: "episodic",
    salience: sanitizeSalience({ novelty: score, relevance: score, emotional: score * 0.8, predictive: score }),
    tags: tags!.slice(0, 5),
    access_count: 0,
    last_accessed: null,
    created_at: new Date().toISOString(),
    created_active_day: getCurrentActiveDay() > 0 ? getCurrentActiveDay() : null,
    consolidated: false,
    generalized: false,
    source_session: "mcp-store",
    updated_from: null,
  };

  await store.add([memory]);
  log("info", `MCP store: "${content.slice(0, 60)}..." (${scope}, ${salience_hint})`);
  recordEvent({ event: "store", project: projectName, project_hash: projHash, scope, tags: tags!, content_snippet: content.slice(0, 80) });
  return {
    content: [{
      type: "text" as const,
      text: `Stored memory ${memory.id} (${scope}, ${salience_hint}): "${content.slice(0, 80)}..."`,
    }],
  };
});

// --- Tool: forget ---
server.registerTool("forget", {
  title: "Forget Memory",
  description: "Remove a memory by ID. Use when I remember something wrong, outdated, or no longer relevant.",
  inputSchema: {
    memory_id: z.string().describe("ID of the memory to remove"),
  },
}, async ({ memory_id }) => {
  const all = await store.loadAll();
  const mem = all.find((m) => m.id === memory_id);
  if (!mem) {
    return { content: [{ type: "text" as const, text: `Memory ${memory_id} not found.` }], isError: true };
  }

  await store.remove(memory_id);
  await recordSignal(store, "forget", mem.salience);
  log("info", `MCP forget: ${memory_id} "${mem.content.slice(0, 60)}..."`);
  recordEvent({ event: "forget", project: projectName, project_hash: projHash, memory_id, content_snippet: mem.content.slice(0, 80) });
  return {
    content: [{
      type: "text" as const,
      text: `Removed memory: "${mem.content.slice(0, 80)}..."`,
    }],
  };
});

// --- Tool: consolidate ---
server.registerTool("consolidate", {
  title: "Consolidate Memories",
  description: "Run a sleep consolidation cycle on my memories. Merges redundant memories, extracts patterns, prunes faded ones.",
}, async () => {
  const before = (await store.loadAll()).length;

  log("info", `MCP consolidate: starting (${before} memories)`);
  const result = await runConsolidation(store);
  const after = (await store.loadAll()).length;

  const msg = [
    `Consolidation complete (${before} → ${after} memories):`,
    `  Merged: ${result.mergeCount}`,
    `  Generalized: ${result.generalizeCount}`,
    `  Pruned: ${result.pruneCount}`,
    `  Episodic→Semantic: ${result.promotionCount}`,
    ...(result.promotionFailure ? [`  ⚠ ${result.promotionFailure}`] : []),
    `  Notes: ${result.notes}`,
  ].join("\n");

  log("info", `MCP consolidate: done — ${result.mergeCount} merges, ${result.generalizeCount} generalizations, ${result.pruneCount} prunes`);
  recordEvent({ event: "consolidate", project: projectName, project_hash: projHash, merges: result.mergeCount, prunes: result.pruneCount, generalizations: result.generalizeCount, count: after, ...(result.promotionFailure ? { error: result.promotionFailure } : {}) });
  if (result.identity) recordIdentityRewrite(result.identity, projectName, projHash);
  return { content: [{ type: "text" as const, text: msg }] };
});

// --- Tool: deep_recall ---
server.registerTool("deep_recall", {
  title: "Deep Recall (Archived Memories)",
  description: "Search memories that have been archived (faded below the prune threshold but not permanently deleted). Use this when standard recall comes up empty and you have a specific cue. Stricter matching than recall — bring a precise query. A recovered memory is reactivated (moved back to active store).",
  inputSchema: {
    query: z.string().describe("High-specificity search query — exact phrase or strong keyword cluster works best"),
    limit: z.number().optional().default(5).describe("Max results"),
    reactivate: z.boolean().optional().default(false).describe("If true, move the top result back to the active memory store"),
  },
}, async ({ query, limit, reactivate }) => {
  const results = await store.deepRecall(query, { limit: limit ?? 5 });

  if (results.length === 0) {
    return { content: [{ type: "text" as const, text: "No archived memories matched the query." }] };
  }

  let reactivatedId: string | null = null;
  if (reactivate) {
    const top = results[0];
    const recovered = await store.reactivateMemory(top.id);
    if (recovered) {
      reactivatedId = top.id;
      log("info", `MCP deep_recall: reactivated ${top.id}`);
    }
  }

  const output = results.map((m) => ({
    id: m.id,
    content: m.content,
    scope: m.scope,
    memory_type: m.memory_type ?? "episodic",
    tags: m.tags,
    strength: round(calculateStrength(m)),
    archived_at: m.archived_at ?? null,
    reactivated: m.id === reactivatedId,
  }));

  recordEvent({ event: "recall", project: projectName, project_hash: projHash, query: `deep:${query}`, count: output.length });
  return { content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }] };
});

// --- Helpers ---
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// --- Start server ---
async function main() {
  log("info", "MCP server starting");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("info", "MCP server connected");
}

main().catch((e) => {
  console.error("engram MCP server error:", e);
  log("error", `MCP server crash: ${e}`);
  process.exit(1);
});
