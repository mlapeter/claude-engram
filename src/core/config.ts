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
  /** Model for memory extraction (default: "claude-haiku-4-5") */
  extractionModel: string;
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
  extractionModel: "claude-haiku-4-5",
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
