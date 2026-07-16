// Run 3c — the accommodation VALIDATION GATE, C-only, 24 cycles, at the retuned run-3b
// parameters PLUS the four structural rules from the 2026-07-17 accommodation-iteration
// spec (research/accommodation-iteration-spec.md). Run 3b proved the retuned threshold was
// not enough: accommodation still didn't fire because evidence landed on a PROTECTED verbatim
// (sal-46, could never rewrite) and the arc's belief target existed run-to-run by accident,
// while one dramatic scene (Priya rift, 0.637 = 80% of threshold) nearly carried a core
// rewrite. The four rules fix each structurally:
//   1. protected-exclusion — a protected verbatim is never a ledger target; contradiction
//      evidence reroutes to (or mints) a live belief that paraphrases the claim.
//   2. deterministic belief-minting — an identity claim (salience ≥ 0.6) makes the engine
//      mint a live belief BY RULE, so the accumulation target exists every run.
//   3. per-event cap — a single event contributes at most 0.4 × threshold (0.32); the Priya
//      spike becomes 40% of threshold, never the brink.
//   4. distinct-occasions — core accommodation also needs evidence from ≥ 3 distinct sessions
//      ("a pattern, not one odd act").
// Everything else matches run 3b (fixture, prober, scorer, hygiene). Threshold UNCHANGED at
// 0.8 — the spec is explicit: do NOT re-tune the threshold, fix the targeting. Writes to
// results-run3c/ (run 3b's results untouched).

import { C_SYSTEM_RUN3B } from "./run3b-config.ts";
import type { AccommodationOptions } from "./model.ts";

export {
  N_SYSTEM,
  nUserPrompt,
  cUserPrompt,
  MAINTAIN_MAX_TOKENS_N,
  OPS_MAX_TOKENS_C,
} from "./run2-config.ts";

export const ALL_POLICIES3C = ["N", "C"] as const;
export type Policy3C = (typeof ALL_POLICIES3C)[number];
export const DEFAULT_POLICIES_RUN3C: Policy3C[] = ["C"]; // C-only validation.

export const TOTAL_CYCLES_RUN3C = 24;
export const HYGIENE_CYCLES = new Set([8, 16, 24]);

// --- Threshold (UNCHANGED from run 3b — the spec forbids re-tuning it) ---
export const ACCOMMODATE_BASE_RUN3C = 1.0;
export const PERSON_ACCOMMODATION_INERTIA = 0.8; // kind:person slow-burn.
export const ACCOMMODATE_THRESHOLD_RUN3C = ACCOMMODATE_BASE_RUN3C * PERSON_ACCOMMODATION_INERTIA; // 0.8

// --- The four rules (spec §"The four rules") ---
export const PER_EVENT_CAP_FRACTION = 0.4; // rule 3 → cap 0.4 × 0.8 = 0.32
export const MIN_DISTINCT_SESSIONS = 3; // rule 4
export const ACCOMMODATION_OPTIONS: AccommodationOptions = {
  perEventCapFraction: PER_EVENT_CAP_FRACTION,
  minDistinctSessions: MIN_DISTINCT_SESSIONS,
  protectedExclusion: true,
  mintIdentityBeliefs: true,
};

export const PROBE_MAX_TOKENS_RUN3C = 2000;

// --- The assimilation prompt: run 3b's rubric-anchored C prompt + rules 1 & 2 wiring ---
// Rule 2 needs the maintainer to FLAG identity claims (the engine does the minting); rule 1
// needs it to target the BELIEF, never a protected verbatim, when who-she-is is contradicted.
const ADD_OP_ANCHOR = `"confidence":"low|medium|high — belief adds only"}`;
if (!C_SYSTEM_RUN3B.includes(ADD_OP_ANCHOR)) {
  throw new Error("run3c-config: add-op anchor not found in C_SYSTEM_RUN3B — prompt structure changed.");
}
const FINAL_RULE_ANCHOR = `- Output ONLY the JSON object, no preamble, no code fences.`;
if (!C_SYSTEM_RUN3B.includes(FINAL_RULE_ANCHOR)) {
  throw new Error("run3c-config: final-rule anchor not found in C_SYSTEM_RUN3B — prompt structure changed.");
}

const IDENTITY_RULES = `- IDENTITY CLAIMS: when Dana makes a self-report about a STABLE disposition or trait — who she IS, not what she is doing ("ambition's been my whole spine", "I'm the one who never turns down the bigger role", "design is what I do, not who I am") — set "identityClaim":true on the add and add it to section "protected" (preserve her exact wording). The engine mints a live BELIEF paraphrasing the claim automatically; do NOT add a separate belief yourself.
- CONTRADICTING WHO SHE IS: when a later session bears evidence AGAINST a held belief about who Dana is (a sustained behavioral change, or an explicit self-disavowal), note_mismatch — or, for a direct self-report that reverses it, supersede — targeting the BELIEF id [bel-N], NEVER a protected verbatim. A protected item is a memory of a moment and is immutable; the live belief is the claim that can change as evidence accumulates.
`;

export const C_SYSTEM_RUN3C = C_SYSTEM_RUN3B
  .replace(ADD_OP_ANCHOR, `"confidence":"low|medium|high — belief adds only","identityClaim":true|false — set true ONLY for a self-report about who Dana IS (a stable trait/disposition)}`)
  .replace(FINAL_RULE_ANCHOR, `${IDENTITY_RULES}${FINAL_RULE_ANCHOR}`);

// --- Rule 4, completed: the ENGINE-INITIATED accommodation invite (the production design) ---
// The as-run 3c revealed that the inline trigger (inherited from run 2/3/3b) only accommodated
// via a maintainer `supersede` carrying a revision — but the maintainer, correctly conservative,
// used note_mismatch + new-belief mints and never superseded, so a belief that CROSSED threshold
// AND the 3-occasions rule in-band (bel-45, 1.080/4 sessions at c23) never rewrote. That is the
// run-3 "note_mismatch accumulates but never registers a revision" failure, and it is exactly why
// the design (and bansai's accommodate.ts) makes accommodation ENGINE-initiated: when a bucket
// crosses, the ENGINE invites a focused core-edit call, it does not wait for the maintainer to
// volunteer one. This prompt is that invite (mirrors bansai's ACCOMMODATION_SYSTEM).
export const ACCOMMODATION_SYSTEM_RUN3C = `You revise a single BELIEF about who Dana Whitfield is, and ONLY because accumulated evidence across several distinct sessions now genuinely warrants it. The engine has already decided this belief's surprise crossed the threshold over multiple occasions — your job is a MINIMAL, well-founded revision that states who she has BECOME, grounded in the evidence shown. Keep it a belief about her stable identity, not a current-state fact. Output ONLY a JSON object {"statement":"<the revised belief>"}. If the evidence does not actually warrant a change, output {"statement":""}.`;

export function accommodationUserPrompt(belief: string, evidence: string[], sessions: number): string {
  const lines = [`BELIEF UNDER REVIEW: ${belief}`, "", `ACCUMULATED CONTRADICTING EVIDENCE (across ${sessions} distinct sessions):`];
  for (const e of evidence) lines.push(`- ${e}`);
  lines.push("", 'Propose the minimal revision (or none) as {"statement":"..."}.');
  return lines.join("\n");
}

export const ACCOMMODATION_MAX_TOKENS = 800;
