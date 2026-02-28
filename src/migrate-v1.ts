#!/usr/bin/env bun
/**
 * Migrate v1 artifact memories to v4 Claude Code format.
 *
 * Usage:
 *   bun run src/migrate-v1.ts /path/to/backup.json [--dry-run]
 */

import { readFileSync } from "node:fs";
import { createStore } from "./core/store.js";
import { sanitizeSalience, scopeFromTags, generateId } from "./core/types.js";
import type { Memory, Salience } from "./core/types.js";
import { calculateStrength } from "./core/strength.js";
import { log } from "./core/logger.js";

// --- v1 schema types ---

interface V1Salience {
  novelty?: number;
  relevance?: number;
  emotional?: number;
  predictive?: number;
  // Early v1 used different names
  importance?: number;
  actionable?: number;
}

interface V1Memory {
  id: string;
  content: string;
  salience: V1Salience;
  tags: string[];
  accessCount: number;
  lastAccessed: number | null;
  createdAt: number;
  consolidated: boolean;
  generalized: boolean;
}

interface V1Backup {
  memories: V1Memory[];
  meta?: unknown;
  briefing?: string;
  exportedAt?: number;
  version?: string;
}

// --- Migration logic ---

function normalizeSalience(v1: V1Salience): Salience {
  return sanitizeSalience({
    novelty: v1.novelty ?? v1.importance ?? 0,
    relevance: v1.relevance ?? 0,
    emotional: v1.emotional ?? 0,
    predictive: v1.predictive ?? v1.actionable ?? 0,
  });
}

function epochToISO(epoch: number | null): string | null {
  if (epoch == null || epoch === 0) return null;
  return new Date(epoch).toISOString();
}

function convertMemory(v1: V1Memory): Memory {
  const salience = normalizeSalience(v1.salience);
  const scope = scopeFromTags(v1.tags);

  return {
    id: generateId(),
    content: v1.content.slice(0, 400),
    scope,
    salience,
    tags: v1.tags.slice(0, 5),
    access_count: v1.accessCount ?? 0,
    last_accessed: epochToISO(v1.lastAccessed),
    created_at: epochToISO(v1.createdAt) ?? new Date().toISOString(),
    consolidated: v1.consolidated ?? false,
    generalized: v1.generalized ?? false,
    source_session: "v1-import",
    updated_from: null,
  };
}

function isDuplicate(v4: Memory, existing: Memory[]): Memory | null {
  const v4Lower = v4.content.toLowerCase();
  for (const e of existing) {
    const eLower = e.content.toLowerCase();
    // Check for substantial overlap (one contains the other, or very similar)
    if (v4Lower.includes(eLower) || eLower.includes(v4Lower)) {
      return e;
    }
    // Check for first 80 chars matching (catches truncation differences)
    if (v4Lower.slice(0, 80) === eLower.slice(0, 80)) {
      return e;
    }
  }
  return null;
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const filePath = args.find((a) => !a.startsWith("--"));

  if (!filePath) {
    console.error("Usage: bun run src/migrate-v1.ts /path/to/backup.json [--dry-run]");
    process.exit(1);
  }

  // Read backup
  let backup: V1Backup;
  try {
    const raw = readFileSync(filePath, "utf-8");
    backup = JSON.parse(raw);
  } catch (e) {
    console.error(`Failed to read backup file: ${e}`);
    process.exit(1);
  }

  console.log(`\nv1 → v4 Memory Migration`);
  console.log(`========================`);
  console.log(`Source: ${filePath}`);
  console.log(`Version: ${backup.version ?? "unknown"}`);
  console.log(`Memories in backup: ${backup.memories.length}`);
  if (dryRun) console.log(`Mode: DRY RUN (no changes will be written)\n`);
  else console.log(`Mode: LIVE\n`);

  // Use a generic cwd — v1 memories are all global anyway
  const store = createStore(process.cwd());
  const existing = await store.loadAll();
  console.log(`Existing v4 memories: ${existing.length}`);

  // Convert all
  const converted: Memory[] = [];
  const skipped: { content: string; reason: string }[] = [];

  for (const v1mem of backup.memories) {
    const v4mem = convertMemory(v1mem);
    const strength = calculateStrength(v4mem);

    // Skip near-zero strength (already decayed away)
    if (strength < 0.05) {
      skipped.push({ content: v4mem.content.slice(0, 60), reason: `strength ${strength.toFixed(3)}` });
      continue;
    }

    // Skip duplicates of existing memories
    const dup = isDuplicate(v4mem, existing);
    if (dup) {
      skipped.push({ content: v4mem.content.slice(0, 60), reason: `duplicate of "${dup.content.slice(0, 40)}..."` });
      continue;
    }

    // Skip duplicates within the import batch itself
    const batchDup = isDuplicate(v4mem, converted);
    if (batchDup) {
      skipped.push({ content: v4mem.content.slice(0, 60), reason: `batch duplicate` });
      continue;
    }

    converted.push(v4mem);
  }

  // Report
  const byScope = { global: 0, project: 0 };
  for (const m of converted) byScope[m.scope]++;

  console.log(`\nResults:`);
  console.log(`  Will import: ${converted.length} memories`);
  console.log(`    → global: ${byScope.global}`);
  console.log(`    → project: ${byScope.project}`);
  console.log(`  Skipped: ${skipped.length}`);

  if (skipped.length > 0) {
    console.log(`\nSkipped details:`);
    for (const s of skipped) {
      console.log(`  - "${s.content}..." → ${s.reason}`);
    }
  }

  if (converted.length > 0) {
    console.log(`\nSample converted memories (top 5 by strength):`);
    const top = [...converted]
      .sort((a, b) => calculateStrength(b) - calculateStrength(a))
      .slice(0, 5);
    for (const m of top) {
      console.log(`  [${calculateStrength(m).toFixed(2)}] (${m.scope}) ${m.content.slice(0, 80)}...`);
    }
  }

  if (dryRun) {
    console.log(`\nDry run complete. Re-run without --dry-run to import.`);
    return;
  }

  // Backup existing before import
  if (existing.length > 0) {
    const backupPath = await store.backup();
    console.log(`\nBacked up existing memories to: ${backupPath}`);
  }

  // Import
  await store.add(converted);
  log("info", `Migrated ${converted.length} memories from v1 backup (${skipped.length} skipped)`);

  const total = await store.loadAll();
  console.log(`Import complete. Total memories: ${total.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
