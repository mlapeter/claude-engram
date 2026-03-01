import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "./types.js";

export interface EngramConfig {
  /** Strength lost per day (default: 0.015) */
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
  /** Strength threshold for auto-pruning (default: 0.03) */
  pruneThreshold: number;
  /** Model for memory extraction (default: "claude-haiku-4-5") */
  extractionModel: string;
  /** Model for briefing generation (default: "claude-sonnet-4-5") */
  briefingModel: string;
  /** Model for consolidation (default: "claude-sonnet-4-5") */
  consolidationModel: string;
  /** Max memories to include in briefing (default: 60) */
  briefingMaxMemories: number;
  /** Max backups to keep (default: 5) */
  maxBackups: number;
  /** Salience damping factor for superseded memories (default: 0.7) */
  interferenceFactor: number;
  /** Memory count above which consolidation uses Haiku pre-filter (default: 100) */
  consolidationBatchThreshold: number;
}

const DEFAULTS: EngramConfig = {
  decayRate: 0.015,
  retrievalBoost: 0.12,
  maxRetrievalBonus: 0.5,
  consolidationBonus: 0.2,
  autoConsolidationMinMemories: 50,
  autoConsolidationMinDays: 3,
  pruneThreshold: 0.03,
  extractionModel: "claude-haiku-4-5",
  briefingModel: "claude-sonnet-4-5",
  consolidationModel: "claude-sonnet-4-5",
  briefingMaxMemories: 60,
  maxBackups: 5,
  interferenceFactor: 0.7,
  consolidationBatchThreshold: 100,
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
