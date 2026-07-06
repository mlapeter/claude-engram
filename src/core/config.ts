import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "./types.js";

export interface EngramConfig {
  /**
   * Decay model used by the strength computation engine.
   * - "power-law": rate * sqrt(age_days) — Ebbinghaus/Wixted, rapid initial then flattens (preferred)
   * - "exponential": 1 - exp(-rate * age_days) — classical Ebbinghaus exponential
   * - "linear": rate * age_days — uniform decay
   * Default: "power-law"
   */
  decayModel: "power-law" | "exponential" | "linear";
  /** Strength decay coefficient — interpretation depends on decayModel (default: 0.035 for power-law) */
  decayRate: number;
  /** Strength gained per retrieval (default: 0.12) */
  retrievalBoost: number;
  /** Max bonus from retrievals (default: 0.5) */
  maxRetrievalBonus: number;
  /** Bonus for consolidated memories (default: 0.2) */
  consolidationBonus: number;
  /** Min memories before auto-consolidation triggers (default: 50) */
  autoConsolidationMinMemories: number;
  /** Min days between auto-consolidations (default: 3) */
  autoConsolidationMinDays: number;
  /** Strength threshold for auto-pruning (default: 0.03) — pruned memories are migrated to deep archive */
  pruneThreshold: number;
  /** Decay rate for archived memories — substantially lower than active (default: 0.001 per day) */
  archiveDecayRate: number;
  /** Model for memory extraction — the front door to the world-store; small
   * models measurably confabulate here (default: "claude-sonnet-4-5") */
  extractionModel: string;
  /** Model for gist compression — mechanical, and never-destroy makes its
   * mistakes recoverable (default: "claude-haiku-4-5") */
  gistModel: string;
  /** Memories per gist-compression call — output must fit max_tokens or the
   * JSON truncates mid-string and the chunk fails (default: 40) */
  gistChunkSize: number;
  /** Model for briefing generation (default: "claude-opus-4-6") */
  briefingModel: string;
  /** Model for consolidation (default: "claude-sonnet-4-5") */
  consolidationModel: string;
  /** Max memories to include in briefing (default: 60) */
  briefingMaxMemories: number;
  /** Max backups to keep (default: 5) */
  maxBackups: number;
  /** Salience damping factor for superseded memories (default: 0.7) */
  interferenceFactor: number;
  /** Memory count above which consolidation uses two-pass embedding similarity clustering (default: 100) */
  consolidationBatchThreshold: number;
  /** Enable vector embeddings for semantic search (default: true, requires VOYAGE_API_KEY) */
  embeddingsEnabled: boolean;
  /** Voyage AI model for embeddings (default: "voyage-3-lite") */
  embeddingModel: string;
  /** Weight of vector score in hybrid search, 0=token only, 1=vector only (default: 0.4) */
  hybridVectorWeight: number;
  /** At Stop, ask the session model itself to write a first-person episode (default: true) */
  episodeSelfDump: boolean;
  /** Model that rewrites identity documents at consolidation — highest-stakes text in the system (default: "claude-opus-4-6") */
  identityModel: string;
  /** Keep full memory history as git commits in the data dir (default: true) */
  memoryHistory: boolean;
  /** Memories with emotional salience at/above this are exempt from gist compression (default: 0.75) */
  sacredEmotionalThreshold: number;
  /** Register physics: craft (work knowledge, re-derivable) decays faster than person/self */
  decayMultiplierCraft: number;
  decayMultiplierPerson: number;
  decayMultiplierSelf: number;
  /** Observer mode: recalls read without strengthening — flip on while developing/testing
   * the memory system itself so repeated handling doesn't over-strengthen core memories */
  observerMode: boolean;
  /** Flush the encoding buffer when it exceeds this many bytes (default: 32768) */
  bufferFlushBytes: number;
  /** Flush the encoding buffer when its oldest content exceeds this age (default: 4h) */
  bufferFlushHours: number;
  /** Sleep (consolidation) triggers on a new active day once at least this many
   * memories arrived since the last sleep — or any identity deltas are pending (default: 5) */
  sleepMinNewMemories: number;
}

const DEFAULTS: EngramConfig = {
  decayModel: "power-law",
  decayRate: 0.035,
  retrievalBoost: 0.12,
  maxRetrievalBonus: 0.5,
  consolidationBonus: 0.2,
  autoConsolidationMinMemories: 50,
  autoConsolidationMinDays: 3,
  pruneThreshold: 0.03,
  archiveDecayRate: 0.001,
  extractionModel: "claude-sonnet-4-5",
  gistModel: "claude-haiku-4-5",
  gistChunkSize: 40,
  briefingModel: "claude-opus-4-6",
  consolidationModel: "claude-sonnet-4-5",
  briefingMaxMemories: 60,
  maxBackups: 5,
  interferenceFactor: 0.7,
  consolidationBatchThreshold: 100,
  embeddingsEnabled: true,
  embeddingModel: "voyage-3-lite",
  hybridVectorWeight: 0.4,
  episodeSelfDump: true,
  identityModel: "claude-opus-4-6",
  memoryHistory: true,
  sacredEmotionalThreshold: 0.75,
  decayMultiplierCraft: 1.3,
  decayMultiplierPerson: 0.85,
  decayMultiplierSelf: 0.85,
  observerMode: false,
  bufferFlushBytes: 32_768,
  bufferFlushHours: 4,
  sleepMinNewMemories: 5,
};

let cachedConfig: EngramConfig | null = null;

/** Load config from ~/.claude-engram/config.json, merged with defaults. */
export function loadConfig(): EngramConfig {
  if (cachedConfig) return cachedConfig;

  const configPath = join(getDataDir(), "config.json");
  try {
    const raw = readFileSync(configPath, "utf-8");
    const userConfig = JSON.parse(raw);
    cachedConfig = { ...DEFAULTS, ...userConfig };
  } catch {
    cachedConfig = { ...DEFAULTS };
  }

  return cachedConfig!;
}

/** Reset cached config (useful for testing). */
export function resetConfig(): void {
  cachedConfig = null;
}

/**
 * Observer mode check — read FRESH each call (bypasses the config cache) so a
 * long-lived MCP server honors a config flip without restart, and hooks honor
 * the ENGRAM_OBSERVER env var per-session. In observer mode, recalls read
 * without strengthening: no access bumps, no salience signals.
 */
export function isObserverMode(): boolean {
  if (process.env.ENGRAM_OBSERVER) return true;
  try {
    const raw = readFileSync(join(getDataDir(), "config.json"), "utf-8");
    return JSON.parse(raw).observerMode === true;
  } catch {
    return false;
  }
}
