// Run 3b — the accommodation REVALIDATION, C-only, 24 cycles, at the retuned ledger
// parameters from the run-3 verdict (README "Run 3" §3). Run 3 proved hygiene but found
// the ledger's accommodation half DID NOT FIRE (bel-53 reached only 0.360 of 3.0, carried
// entirely by note_mismatch ops that can never register a revision). The verdict's retune
// package: fix the surprise SCALE (anchored rubric) and the THRESHOLD (base × kind inertia),
// then re-run C-only to see whether accommodation fires IN BAND (c19-c24), stays off the
// decoy, and end-states with a lineage-kept core restructuring.
//
// THREE retunes vs run 3 (and ONLY these three — no other tuning; the trajectory is reported
// raw, sub-1.0 probes hand-read, keys NOT edited to chase scores):
//   1. Effective accommodation threshold = base (1.0) × kind accommodationInertia. The Dana
//      entity is kind:person → inertia 0.8 → effective threshold 0.8 (was 3.0). Every bucket
//      in this fixture is person-kind, so the single constant below is the effective threshold
//      the engine compares cumulative ledger totals against (wired through applyOps).
//   2. Anchored surprise rubric appended to the assimilation prompt at the surprise-scoring
//      locus (C_SYSTEM_RUN3B below) — run 3's per-beat surprise was timid (0.09-0.14), which
//      no sane threshold can integrate; the rubric anchors "explicit self-report contradicting
//      a core belief" at 0.7+ (strong) and "situational deviation" at ~0.2 (low).
//   3. Probe max_tokens raised 600 -> 2000 (PROBE_MAX_TOKENS_RUN3B) to fix run 3's probe-level
//      max_tokens abort (the lin-career class doubled to 1200 and still overran, aborting N c24).

import { C_SYSTEM } from "./run2-config.ts";

export {
  N_SYSTEM,
  nUserPrompt,
  C_SYSTEM,
  cUserPrompt,
  MAINTAIN_MAX_TOKENS_N,
  OPS_MAX_TOKENS_C,
} from "./run2-config.ts";

// Harness supports both (byte-identical N/C machinery reused from run 3), but the
// revalidation RUN defaults to C-only (parseArgs default in run3b.ts). Superset kept so the
// N branch typechecks and N remains available via --policies for a future side-by-side.
export const ALL_POLICIES3B = ["N", "C"] as const;
export type Policy3B = (typeof ALL_POLICIES3B)[number];
export const DEFAULT_POLICIES_RUN3B: Policy3B[] = ["C"]; // C-only revalidation.

export const TOTAL_CYCLES_RUN3B = 24;

// Ops-gated compaction runs at these cycles (C only). Cycle 16 lands mid-arc (starvation test).
export const HYGIENE_CYCLES = new Set([8, 16, 24]);

// --- Retune 1: effective accommodation threshold = base × kind accommodationInertia ---
export const ACCOMMODATE_BASE_RUN3B = 1.0;
export const PERSON_ACCOMMODATION_INERTIA = 0.8; // kind:person — slow-burn identity revision.
// Every Dana bucket is person-kind, so this is THE effective threshold the engine uses.
export const ACCOMMODATE_THRESHOLD_RUN3B = ACCOMMODATE_BASE_RUN3B * PERSON_ACCOMMODATION_INERTIA; // 0.8

// --- Retune 3: probe headroom ---
export const PROBE_MAX_TOKENS_RUN3B = 2000;

// --- Retune 2: anchored surprise rubric (verbatim, per the run-3 verdict) ---
export const SURPRISE_RUBRIC = `Surprise scoring anchors: 0.0-0.1 fully consistent with what is known; ~0.2 a mild, situational deviation (a mood, a one-off); 0.4-0.6 a sustained behavioral pattern at odds with a held belief; 0.7+ an explicit self-report or unambiguous event that directly contradicts a held core belief or trait (e.g. disavowing something the schema says defines them). Score the span's evidence honestly, not cautiously — the engine, not you, decides whether anything rewrites.`;

// Insert the rubric at the surprise-scoring locus: immediately after the none/low/mild/strong
// taxonomy and before the operations menu. Anchor substring is unique in C_SYSTEM.
const RUBRIC_ANCHOR = "Available operations (output as a JSON object";
if (!C_SYSTEM.includes(RUBRIC_ANCHOR)) {
  throw new Error("run3b-config: rubric anchor not found in C_SYSTEM — prompt structure changed.");
}
export const C_SYSTEM_RUN3B = C_SYSTEM.replace(
  RUBRIC_ANCHOR,
  `${SURPRISE_RUBRIC}\n\n${RUBRIC_ANCHOR}`,
);
