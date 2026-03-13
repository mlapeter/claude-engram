/**
 * Bidirectional schema conversion between v1 (artifact) and v4 (Claude Code) memory formats.
 */

import { sanitizeSalience, scopeFromTags, generateId } from "../core/types.js";
import type { Memory, Salience } from "../core/types.js";

// --- v1 Types ---

export interface V1Salience {
  novelty?: number;
  relevance?: number;
  emotional?: number;
  predictive?: number;
  // Early v1 used different names
  importance?: number;
  actionable?: number;
}

export interface V1Memory {
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

export interface V1Backup {
  memories: V1Memory[];
  meta?: { lastConsol: number | null; created: number | null };
  briefing?: string;
  exportedAt?: number;
  version?: string;
}

// --- v1 → v4 ---

export function v1ToV4(v1: V1Memory): Memory {
  return {
    id: generateId(),
    content: v1.content.slice(0, 400),
    scope: scopeFromTags(v1.tags || []),
    memory_type: "episodic",
    salience: sanitizeSalience({
      novelty: v1.salience?.novelty ?? v1.salience?.importance ?? 0,
      relevance: v1.salience?.relevance ?? 0,
      emotional: v1.salience?.emotional ?? 0,
      predictive: v1.salience?.predictive ?? v1.salience?.actionable ?? 0,
    }),
    tags: (v1.tags || []).slice(0, 5),
    access_count: v1.accessCount ?? 0,
    last_accessed: epochToISO(v1.lastAccessed),
    created_at: epochToISO(v1.createdAt) ?? new Date().toISOString(),
    consolidated: v1.consolidated ?? false,
    generalized: v1.generalized ?? false,
    source_session: "v1-sync",
    updated_from: null,
  };
}

// --- v4 → v1 ---

export function v4ToV1(v4: Memory): V1Memory {
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    content: v4.content,
    salience: { ...v4.salience },
    tags: v4.tags,
    accessCount: v4.access_count,
    lastAccessed: isoToEpoch(v4.last_accessed),
    createdAt: isoToEpoch(v4.created_at) ?? Date.now(),
    consolidated: v4.consolidated,
    generalized: v4.generalized,
  };
}

/** Convert a full set of v4 global memories to a v1 backup. */
export function toV1Backup(memories: Memory[]): V1Backup {
  return {
    memories: memories.map(v4ToV1),
    meta: { lastConsol: null, created: Date.now() },
    briefing: "",
    exportedAt: Date.now(),
    version: "v3",
  };
}

/** Basic validation of a v1 backup structure. */
export function isValidV1Backup(data: unknown): data is V1Backup {
  if (!data || typeof data !== "object") return false;
  const obj = data as Record<string, unknown>;
  return Array.isArray(obj.memories);
}

// --- Helpers ---

function epochToISO(epoch: number | null | undefined): string | null {
  if (epoch == null || epoch === 0) return null;
  return new Date(epoch).toISOString();
}

function isoToEpoch(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}
