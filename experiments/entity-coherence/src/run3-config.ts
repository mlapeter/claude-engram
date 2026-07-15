// Run 3 configuration — C-with-ops-gated-hygiene vs N, over 24 cycles, per run3-trait-arc-spec.md.
// Reuses run 2's N and C prompts VERBATIM (C_SYSTEM byte-identical → cycles 1-12 stay comparable
// to run 2; hygiene is a SEPARATE call the assimilation step never sees). The only physics change
// vs run 2 is the accommodation threshold: run 3 uses the Phase-0 default (3.0), and the trajectory
// is reported raw — NOT tuned to make the arc pass (spec §3).

export {
  N_SYSTEM,
  nUserPrompt,
  C_SYSTEM,
  cUserPrompt,
  MAINTAIN_MAX_TOKENS_N,
  OPS_MAX_TOKENS_C,
} from "./run2-config.ts";

export const ALL_POLICIES3 = ["N", "C"] as const;
export type Policy3 = (typeof ALL_POLICIES3)[number];

export const TOTAL_CYCLES_RUN3 = 24;

// Phase-0 default. Configurable; reported raw. (Run 2 used 1.0.)
export const ACCOMMODATE_THRESHOLD_RUN3 = 3.0;

// Ops-gated compaction runs at these cycles (C only). Cycle 16 lands mid-arc (the starvation test).
export const HYGIENE_CYCLES = new Set([8, 16, 24]);
