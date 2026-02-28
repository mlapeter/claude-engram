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
import { generateId, sanitizeSalience, scopeFromTags, getDataDir } from "../core/types.js";
import type { Memory } from "../core/types.js";
import { log } from "../core/logger.js";
import { runConsolidation } from "../core/consolidation.js";

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
  description: "Get a health overview of the memory bank. Shows total count, average strength, consolidation status.",
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
  const lastConsol = globalMeta.lastConsolidation || projectMeta.lastConsolidation;
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
  description: "Search memories by text query. Returns matching memories ranked by relevance x strength. Use when a topic comes up that might have relevant history.",
  inputSchema: {
    query: z.string().describe("Search query"),
    limit: z.number().optional().default(5).describe("Max results"),
    min_strength: z.number().optional().default(0.1).describe("Minimum strength threshold"),
  },
}, async ({ query, limit, min_strength }) => {
  const results = await store.search(query, limit! + 10); // over-fetch to filter
  const filtered = results.filter((m) => calculateStrength(m) >= min_strength!).slice(0, limit);

  // Hebbian reinforcement: accessed memories get stronger
  for (const m of filtered) {
    await store.update(m.id, {
      access_count: m.access_count + 1,
      last_accessed: new Date().toISOString(),
    });
  }

  const output = filtered.map((m) => ({
    id: m.id,
    content: m.content,
    scope: m.scope,
    tags: m.tags,
    strength: round(calculateStrength(m)),
    created_at: m.created_at,
  }));

  log("info", `MCP recall: "${query}" → ${output.length} results`);
  return { content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }] };
});

// --- Tool: search_by_tag ---
server.registerTool("search_by_tag", {
  title: "Search by Tag",
  description: "Find memories with specific tags. Use for pulling up everything about a topic, project, or person. Tags: identity, goal, preference, project, relationship, skill, insight, contradiction, pattern, context, technical, personal, business, creative.",
  inputSchema: {
    tags: z.array(z.string()).describe("Tags to search for (OR logic)"),
    limit: z.number().optional().default(10).describe("Max results"),
  },
}, async ({ tags, limit }) => {
  const results = await store.searchByTag(tags, limit);

  // Hebbian reinforcement
  for (const m of results) {
    await store.update(m.id, {
      access_count: m.access_count + 1,
      last_accessed: new Date().toISOString(),
    });
  }

  const output = results.map((m) => ({
    id: m.id,
    content: m.content,
    scope: m.scope,
    tags: m.tags,
    strength: round(calculateStrength(m)),
    created_at: m.created_at,
  }));

  log("info", `MCP search_by_tag: [${tags.join(", ")}] → ${output.length} results`);
  return { content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }] };
});

// --- Tool: reinforce ---
server.registerTool("reinforce", {
  title: "Reinforce Memory",
  description: "Strengthen a memory that proved relevant or useful. Like Hebbian learning — accessed memories get stronger. Optionally update the memory's content (reconsolidation) — use this when a memory is mostly right but needs correction or refinement.",
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

  const newStrength = calculateStrength({ ...mem, access_count: mem.access_count + 1 });
  log("info", `MCP reinforce: ${memory_id} → strength ${round(newStrength)}${new_content ? " (content updated)" : ""}`);
  return {
    content: [{
      type: "text" as const,
      text: `${action} "${(new_content || mem.content).slice(0, 60)}..." — strength: ${round(newStrength)}`,
    }],
  };
});

// --- Tool: store ---
server.registerTool("store", {
  title: "Store Memory",
  description: "Immediately store an important memory. Use when something significant happens that shouldn't wait for session end — major decisions, surprising revelations, emotional moments.",
  inputSchema: {
    content: z.string().max(400).describe("Memory content (max 400 chars)"),
    tags: z.array(z.string()).optional().default(["insight"]).describe("1-5 tags"),
    salience_hint: z.enum(["low", "medium", "high", "critical"]).optional().default("medium").describe("Importance level"),
  },
}, async ({ content, tags, salience_hint }) => {
  const hintMap: Record<string, number> = { low: 0.3, medium: 0.5, high: 0.7, critical: 0.9 };
  const score = hintMap[salience_hint!] ?? 0.5;
  const scope = scopeFromTags(tags!);

  const memory: Memory = {
    id: generateId(),
    content: content.slice(0, 400),
    scope,
    salience: sanitizeSalience({ novelty: score, relevance: score, emotional: score * 0.8, predictive: score }),
    tags: tags!.slice(0, 5),
    access_count: 0,
    last_accessed: null,
    created_at: new Date().toISOString(),
    consolidated: false,
    generalized: false,
    source_session: "mcp-store",
    updated_from: null,
  };

  await store.add([memory]);
  log("info", `MCP store: "${content.slice(0, 60)}..." (${scope}, ${salience_hint})`);
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
  description: "Remove a memory by ID. Use when a memory is wrong, outdated, or no longer relevant.",
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
  log("info", `MCP forget: ${memory_id} "${mem.content.slice(0, 60)}..."`);
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
  description: "Run a sleep consolidation cycle. Merges redundant memories, extracts patterns, prunes dead memories.",
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
    `  Notes: ${result.notes}`,
  ].join("\n");

  log("info", `MCP consolidate: done — ${result.mergeCount} merges, ${result.generalizeCount} generalizations, ${result.pruneCount} prunes`);
  return { content: [{ type: "text" as const, text: msg }] };
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
