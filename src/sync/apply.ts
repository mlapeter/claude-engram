/**
 * Apply a reconciliation plan — writes merged result to v4 store
 * and generates a v1-format export of the full merged set.
 */

import type { MemoryStore } from "../core/store.js";
import type { Memory } from "../core/types.js";
import type { ReconciliationPlan, SimilarPair } from "./reconcile.js";
import { toV1Backup, type V1Backup } from "./schema.js";
import { log } from "../core/logger.js";

// --- Types ---

export type SimilarResolution =
  | { action: "keep-v4" }
  | { action: "keep-v1" }
  | { action: "merge" }
  | { action: "keep-both" }
  | { action: "skip" };

export interface ApplyOptions {
  plan: ReconciliationPlan;
  /** One decision per similar pair, indexed by position in plan.similar */
  similarResolutions: SimilarResolution[];
}

export interface ApplyResult {
  /** Path to pre-sync backup */
  backupPath: string;
  /** Number of memories added to v4 from v1 */
  addedToV4: number;
  /** Number of similar pairs merged/resolved */
  resolvedSimilar: number;
  /** Total v4 global memories after sync */
  totalV4Global: number;
  /** v1 backup of the full merged set, ready for download */
  v1Export: V1Backup;
}

export async function applySync(
  store: MemoryStore,
  opts: ApplyOptions,
): Promise<ApplyResult> {
  const { plan, similarResolutions } = opts;

  // 1. Backup before any writes
  const backupPath = await store.backup();
  log("info", `Sync apply: backup at ${backupPath}`);

  // 2. Load current v4 global memories (fresh read, not cached from reconcile)
  const currentGlobal = await store.load("global");

  // 3. Build the add list and replacement map
  const toAdd: Memory[] = [];
  const toReplace = new Map<string, Memory>(); // v4 id → replacement

  // New from v1 → add
  for (const item of plan.newFromV1) {
    toAdd.push(item.asV4);
  }

  // Similar pairs → resolve per user decision
  let resolvedCount = 0;
  for (let i = 0; i < plan.similar.length; i++) {
    const pair = plan.similar[i];
    const resolution = similarResolutions[i] ?? { action: "keep-v4" };

    switch (resolution.action) {
      case "keep-v4":
        // No change needed
        break;
      case "keep-v1":
        toReplace.set(pair.v4.id, pair.v1AsV4);
        resolvedCount++;
        break;
      case "merge":
        toReplace.set(pair.v4.id, pair.suggestedMerge);
        resolvedCount++;
        break;
      case "keep-both":
        toAdd.push(pair.v1AsV4);
        resolvedCount++;
        break;
      case "skip":
        break;
    }
  }

  // 4. Build final v4 global set
  const finalGlobal = currentGlobal.map((m) => toReplace.get(m.id) ?? m);
  finalGlobal.push(...toAdd);

  // 5. Write to store
  await store.save("global", finalGlobal);
  log("info", `Sync apply: wrote ${finalGlobal.length} global memories (${toAdd.length} added, ${toReplace.size} replaced)`);

  // 6. Generate v1 export of the full merged global set
  const v1Export = toV1Backup(finalGlobal);

  return {
    backupPath,
    addedToV4: toAdd.length,
    resolvedSimilar: resolvedCount,
    totalV4Global: finalGlobal.length,
    v1Export,
  };
}

/** Generate a v1 export without modifying the v4 store (skip-upload path). */
export function exportV4AsV1(v4GlobalMemories: Memory[]): V1Backup {
  return toV1Backup(v4GlobalMemories);
}
