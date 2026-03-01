import { createHash } from "node:crypto";
import { z } from "zod";

// --- Zod Schemas ---

export const SalienceSchema = z.object({
  novelty: z.number().min(0).max(1).default(0),
  relevance: z.number().min(0).max(1).default(0),
  emotional: z.number().min(0).max(1).default(0),
  predictive: z.number().min(0).max(1).default(0),
});

export const MemorySchema = z.object({
  id: z.string(),
  content: z.string().max(400),
  scope: z.enum(["global", "project"]),
  /** Fuzzy Trace Theory: episodic details fade to semantic gist over time */
  memory_type: z.enum(["episodic", "semantic"]).default("episodic"),
  salience: SalienceSchema,
  tags: z.array(z.string()).min(1).max(5),
  access_count: z.number().int().min(0),
  last_accessed: z.string().nullable(),
  created_at: z.string(),
  consolidated: z.boolean(),
  generalized: z.boolean(),
  source_session: z.string(),
  updated_from: z.string().nullable(),
});

export const ExtractedMemorySchema = z.object({
  content: z.string(),
  scope: z.enum(["global", "project"]),
  salience: SalienceSchema,
  tags: z.array(z.string()),
  updates: z.string().nullable(),
});

// --- TypeScript Interfaces ---

export type Salience = z.infer<typeof SalienceSchema>;
export type Memory = z.infer<typeof MemorySchema>;
export type ExtractedMemory = z.infer<typeof ExtractedMemorySchema>;

export type NewMemory = Omit<Memory, "id" | "access_count" | "last_accessed" | "created_at" | "consolidated" | "generalized" | "updated_from"> & {
  updates: string | null;
};

export interface Meta {
  lastConsolidation: string | null;
  created: string;
  sessionCount: number;
  /** VTA dopamine signals for learned salience adaptation */
  salience_signals?: Array<{ event: string; salience: Salience; timestamp: string }>;
  /** Cached computed weights (invalidated on new signal) */
  salience_weights_cache?: Record<string, number>;
}

export interface TranscriptCursor {
  byteOffset: number;
  lastSessionId: string;
}

export interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: string;
  // SessionStart
  source?: string;
  model?: string;
  // SessionEnd
  reason?: string;
  // Stop
  stop_hook_active?: boolean;
  last_assistant_message?: string;
}

// --- Constants ---

export const GLOBAL_TAGS = ["identity", "preference", "relationship", "goal", "personal"] as const;
export const PROJECT_TAGS = ["project", "technical", "context"] as const;
export const ALL_TAGS = [
  "identity", "goal", "preference", "project", "relationship",
  "skill", "insight", "contradiction", "pattern", "context",
  "technical", "personal", "business", "creative",
] as const;

// --- Helpers ---

/** Route scope based on tags — global if any global tag present, else project */
export function scopeFromTags(tags: string[]): "global" | "project" {
  if (tags.some((t) => (GLOBAL_TAGS as readonly string[]).includes(t))) {
    return "global";
  }
  return "project";
}

/** Sanitize salience values — converts NaN/undefined to 0 */
export function sanitizeSalience(s: Partial<Salience> | undefined): Salience {
  return {
    novelty: Number(s?.novelty) || 0,
    relevance: Number(s?.relevance) || 0,
    emotional: Number(s?.emotional) || 0,
    predictive: Number(s?.predictive) || 0,
  };
}

/** Generate a unique memory ID */
export function generateId(): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).substring(2, 6);
  return `m_${ts}_${rand}`;
}

/** SHA-256 hash of cwd, truncated to 12 chars */
export function projectHash(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").substring(0, 12);
}

/** Get the data directory root */
export function getDataDir(): string {
  return process.env.ENGRAM_DATA_DIR || `${process.env.HOME}/.claude-engram`;
}
