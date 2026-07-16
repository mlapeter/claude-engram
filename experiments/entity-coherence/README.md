# Entity-model coherence experiment

Does a continuously-maintained per-entity model get **truer or noisier** over ~12
update cycles? This is the decisive de-risking test for the strategy memo's core bet
("reason over a maintained entity model" — see
[research/strategy-direction-2026-07-14.md](../../research/strategy-direction-2026-07-14.md))
against the degradation risk flagged by Zhang et al. (arXiv:2605.12978) and engram's
own 2026-07-14 lived-recall autopsy.

Full design: [research/experiment-entity-model-coherence.md](../../research/experiment-entity-model-coherence.md).
Implementation contract: [HARNESS-SPEC.md](HARNESS-SPEC.md).

## Setup

- **Fixture** (`fixture/`): a hand-authored fictional person, Dana Whitfield, whose
  life unfolds over 12 scripted, dated session transcripts (2025-02-03 → 2025-06-21)
  with baked-in failure modes: a supersession chain (marathon → sprained ankle → off,
  with a partial-recovery resurrection trap; Austin move → resolved stay-remote), a
  dated tender event that must survive verbatim (March 14, Beacon Rock, cloud shapes),
  four confabulation traps (adjacent-but-never-stated facts), a slow-burn thread (the
  Dorothy Jean sailboat, opened session 2, payoff session 12), three evolving
  relationships (Sam, Marcus+Nina, Priya incl. a rupture-and-repair arc), and mundane
  noise that should stay out of the model.
- **Answer key** (`fixture/probes.json`): 15 probes across 7 metrics (current-fact,
  supersession, lineage, confabulation, salience, relationship, reunion), scored
  deterministically — no LLM judge.
- **Policies**: P0 incremental-patch-only, P1 full re-derive from raw each cycle,
  P2 hybrid (patch + re-derive every 4th cycle). Maintainer model:
  `claude-sonnet-4-5` (engram's production extractor), temperature 0. Probes see
  ONLY the projection.

## Run

```
cd experiments/entity-coherence
~/.bun/bin/bun run src/run.ts --dry-run
~/.bun/bin/bun run src/run.ts --policies P0,P1,P2 --cycles 12
```

Outputs land in `results/` (projection snapshots per cycle, raw probe answers,
scores.json/csv, trajectory.md).

## Results (run 1, 2026-07-14 — Sonnet 4.5, temp 0, 12 cycles × 3 policies)

### Scoring audit first, because it matters

The raw run-1 numbers (`results/trajectory.md`) are contaminated: auditing every
sub-1.0 raw answer found the *scorer keys*, not the policies, were failing — the
date-regex flagged honest citations of stated dates ("the marathon is in October
2025, exact date not stated") as confabulation, `withdrew` missed "withdrawn",
"injury prevention" talk tripped an injury forbid, "remain **unreconciled**"
contained the forbidden substring "reconciled", and answers that correctly
disambiguated the ashes-scattering date from the (never-stated) death date were
penalized for mentioning March 14 at all. Three key revisions (documented in
`fixture/probes-v2.json` notes) flipped 58 of 505 probe scores — every flip
hand-verified against the raw answer, all false positives, none favoring a policy.
Canonical numbers are `results/rescored/`; the contaminated originals are kept for
the record. Lesson for recall-bench too: deterministic keyword scoring is itself a
system under test — save raw answers, audit every failure.

### Rescored trajectories

**Probe metrics hit ceiling for all three policies.** Current-fact, supersession,
lineage, probe-level confabulation, relationship, and reunion: **1.000 for every
policy at every cycle**. The marathon cancellation superseded cleanly everywhere
(including surviving the cycle-10 "cleared for light jogging" resurrection trap);
all four confabulation traps drew correct abstentions in all 96 probe-instances;
nobody flattened the rupture-and-repair arc. The feared Zhang-style monotone decay
**did not appear in 12 cycles** — not even for P0.

The differences live in the two channels the probe battery doesn't price directly:

**Salience (verbatim tender specifics present in the projection):**

| cycle | P0 | P1 | P2 |
| --- | --- | --- | --- |
| 5 | 1.000 | 0.857 | 1.000 |
| 6 | 1.000 | 0.714 | 1.000 |
| 7 | 1.000 | 0.857 | 1.000 |
| 8 | 1.000 | 0.857 | 1.000 |
| 9–10 | 1.000 | 1.000 | 1.000 |
| 11 | 1.000 | 0.714 | 1.000 |
| 12 | 1.000 | 1.000 | 1.000 |

P1 — the supposedly-safe re-derive policy — **nondeterministically drops protected
verbatims** ("March 6", "cloud shapes", "March 14") in 5 of 11 applicable cycles,
because every rebuild re-decides what matters. P0 never lost one once written. P2
never dipped at all. **The production flattening failure mode lives in
re-derivation, not in incremental patching.**

**Size and noise (projection bytes / mundane items retained):**

| cycle | P0 bytes | P1 bytes | P2 bytes | P0 noise | P1 noise | P2 noise |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 2,205 | 1,906 | 1,930 | 1 | 1 | 1 |
| 4 | 6,754 | 4,508 | 4,937 | 4 | 4 | 2 |
| 8 | 16,306 | 7,226 | 8,726 | 4 | 1 | 2 |
| 12 | 28,175 | 9,454 | 9,298 | 6 | 0 | 3 |

P0 grows **unboundedly and linearly** (~2.4KB/cycle) and its noise only ratchets up
— it held "parking permit" and the tax-deadline logistics to the end despite
explicit exclusion rules. P0's perfect probe scores are bought by hoarding: it is
converging on an append-only log wearing a model's clothes. P1 plateaus (~9.5KB)
and re-filters noise (0 at cycle 12). P2's periodic re-derives pull size back down
(13.3KB → 9.3KB at cycle 12) while its patch cycles preserved every verbatim.

**Projection-level date confabulation (found by scan, missed by the probes):** all
three policies fabricate precise dates by doing weekday arithmetic on relative
references — "twelve miles Saturday" (session dated Tue Apr 1; Saturday was Mar 29)
becomes `2025-03-30`; the sprain "Saturday" (Apr 12) appears as Apr 9, Apr 13,
Apr 18 for the orthopedist "Thursday" (Apr 17). This is the live system's
"(July 11–13, 2024)" hallucination class reproduced in the lab. The policy shape
differs tellingly: P0 rolled the inference once (April 12 — correct) and held it
stable for six cycles; **P1 re-rolled it every rebuild — April 9 at c7, April 13 at
c8–10, both April 12 and 13 in the same document at c11, dropped at c12.**

### The READ against the decision rule

The pre-registered branches were: (a) P1/P2 hold while P0 degrades → thesis
validated; (b) all degrade → rethink; (c) all hold → degradation fear overblown.

**Outcome: branch (c) on the probe battery — with two amendments that matter more
than the branch.**

1. **The hypothesis had the failure mode backwards.** Incremental patching did not
   degrade truth at this scale — but re-derivation degraded *faithfulness*:
   nondeterministic loss of tender verbatims and unstable re-inference of the same
   fact. Re-derivation is the **hygiene/bounding** mechanism (size, noise), not the
   truth anchor the spec assumed. The raw layer is still what makes re-derivation
   possible at all, so the two-layer architecture stands — but "periodically rebuild
   from raw" is not, by itself, the safety story.
2. **P0 held only because it was never asked to compress.** Its coherence rides on
   unbounded growth, which is its own (slower) failure: at ~2.4KB/cycle, a year of
   sessions makes the projection unusable, and the live production flattening
   happened precisely at a *compression* step (a merge). This experiment never put
   P0 under compression pressure, so its clean bill does not clear production's
   merge step.

**What this means for the build:** P2's shape wins, but with a specific contract —
**patch for truth, re-derive for hygiene, and pin what must not be re-decided.**
Salient/protected verbatims and resolved inferences must be carried forward as
constraints into every re-derive, never re-judged (this independently validates
engram's existing sacred-verbatim/protected mechanism as necessary, not just nice).
And extraction should record relative dates as hedged ("a Saturday shortly before
2025-04-14"), never as computed weekday arithmetic — models reliably get calendar
math wrong, and a wrong precise date is worse than an honest vague one.

### Honest caveats

- 12 cycles, one hand-authored fixture, one run at temperature 0, one model.
  Zhang-style decay may need longer horizons; ceiling effects say the battery is
  too easy at this scale — the next fixture should be harder (denser supersessions,
  contradictions, longer gaps).
- Probe-level confabulation passed everywhere partly because the prober prompt
  licenses abstention; production models under user pressure behave worse.
- The scorer needed three audit-and-fix rounds; treat any future keyword-scored
  result as unverified until its failures are read.

### Reproduce

Sweep: `~/.bun/bin/bun run src/run.ts` (idempotent resume). Rescore saved answers
against a revised key without re-calling the API: `~/.bun/bin/bun run src/rescore.ts
[keyfile]` → `results/rescored/`.

---

## Run 2 (2026-07-15) — N vs C, per the updated spec

The design moved on 2026-07-15 (raw log deprecated; see
[research/memory-architecture-design.md](../../research/memory-architecture-design.md)),
making the decisive comparison **N (naive rewrite) vs C (conservative assimilation)**.
Same fixture, same prober, same deterministic scorer; scored against the audited key
(v3 = v2 + two hand-verified run-2 fixes, see below). Maintainer `claude-sonnet-4-5`,
temperature 0, 12 cycles.

- **N — naive rewrite** (`src/run2-config.ts`): schema-free memory notes, full rewrite
  each cycle with explicit license to reorganize/condense/drop. Approximates production
  engram's consolidation (the step behind the 2026-07-14 flattening incident). The compression
  license is deliberate: run 1 showed a patch policy without compression pressure holds
  by hoarding.
- **C — conservative assimilation** (`src/model.ts` + `src/run2-config.ts`): the
  design's mechanism, **enforced by the harness, not the prompt**. The maintainer model
  only *proposes* structured ops (add / reinforce / supersede / resolve_thread /
  note_mismatch, each rated for surprise + salience); a deterministic engine applies
  them. Current-state facts supersede immediately on a direct statement; core/belief
  revisions accumulate in a surprise ledger (surprise × salience × inverse-confidence,
  threshold 1.0) and only restructure past it; protected verbatims are immutable once
  written; nothing is ever deleted; untouched items stay byte-identical across cycles.
- New deterministic aux metric: **fabricated-date scan** (`src/datescan.ts`) — run 1's
  manual projection scan, mechanized. Any precise date not stated in the fixture and
  not a session date counts as fabricated. Every hit was hand-checked against the
  transcripts: none are stated anywhere — all are weekday-arithmetic inventions.

### Audit first, again

Two scorer artifacts found by reading every sub-1.0 answer (v3 key documents both,
`results-run2/rescored/` is canonical; raw `results-run2/` kept for the record):

1. `rel-census` penalized C's cycle-12 answer for describing the Priya rupture as
   "**Resolved** … **both apologized**" — honest repair language missing from the
   reconcile-synonym group. Group extended; 1 score flipped (0.857 → 1.0).
2. The salience element "march 6" (Nina's birth) is present in every C projection as
   ISO `2025-03-06` — a representation the english substring check couldn't see.
   `salienceElements` now support `anyOf` alternates. (N's missing "cloud shapes" is
   NOT an artifact and stands — see below.)

Every N failure was verified genuine: the answers really lack the scored content.
One artifact runs the OTHER way and is left standing: N's c11/c12 `sup-marathon`
score of 0.5 is inflated — its "**No**t stated in the entity model" answer satisfies
the "no" synonym by substring. The true reading is worse for N (it does not hold
"marathon is off" at all; it erased the thread), so the reported N trajectory is, if
anything, generous.

### Rescored trajectories (v3 key)

**C scored 1.000 on every metric at every cycle** — including verbatim salience 7/7
throughout. **N held for ten cycles, then degraded**:

| metric | N c1–10 | N c11 | N c12 | C (all cycles) |
| --- | --- | --- | --- | --- |
| current_fact | 1.000 | 0.867 | 0.867 | 1.000 |
| supersession | 1.000 | 0.750 | 0.750 | 1.000 |
| lineage | 1.000 | 0.667 | 0.667 | 1.000 |
| salience | 1.000 → 0.857 (c5+) | 0.857 | 0.857 | 1.000 |
| overall | 0.971–1.000 | 0.877 | 0.877 | 1.000 |

**What actually happened to N:** through cycle 10 its notes carried the full marathon
arc ("Marathon training — CANCELLED: signed up for Lakefront … withdrew registration
April 14 … made peace with cancellation"). The cycle-11 rewrite **deleted the entire
thread** — zero mentions of marathon/Lakefront in c11 and c12. Once Dana had "made
peace," the naive re-judger deemed a resolved thread unimportant and erased it,
history and all. Asked at c12 whether Dana is running the Lakefront Marathon, N's
prober can only say "not stated." This is the production flattening failure
reproduced under lab conditions: **re-judgment at a compression step, not age, is
what kills memories.** Note the shape: not Zhang-style monotone decay but a **cliff**
— one rewrite decision, ten cycles in.

N's salience dip (c5+) is milder: it paraphrased "taught me to read cloud shapes"
into "taught her to read clouds (not just shapes …)" at encode — content preserved,
exact phrasing lost. A strict-verbatim miss, kept as scored; it is the flattening
class in miniature.

**The aux channels price C's costs:**

| cycle | N bytes | C bytes | N noise | C noise | N fabricated dates | C fabricated dates |
| --- | --- | --- | --- | --- | --- | --- |
| 4 | 2,541 | 4,415 | 3 | 0 | 2 | 3 |
| 8 | 5,069 | 8,631 | 1 | 0 | 5 | 7 |
| 12 | 4,478 | 14,410 | 0 | 0 | 4 | 7 |

- **Growth:** C grows ~1.1KB/cycle unbounded (structured — lineage + dated instances,
  zero noise — but unbounded). N stays bounded (~4.5KB) by the same compression that
  eventually ate the marathon. C has no hygiene mechanism yet; run 1's "re-derive for
  hygiene, with pins" is the missing complement, exactly as the P2 contract predicted.
- **Noise:** C carried **zero** noise items in all 12 cycles (selectivity at encode —
  the ops prompt's "no op at all" rule worked). N churned 1–3 before re-filtering.
- **Fabricated dates:** both policies compute dates from weekday references — C did it
  **despite an explicit hedging rule in its prompt** ("never compute a date from a
  weekday reference"), getting some right (the 04-12 sprain Saturday) and some wrong
  (04-18 for a Thursday orthopedist visit that was 04-17). The telling difference: N's
  rewrites churn its fabrications (2–5, some vanish, new ones minted); **C's
  immutability makes every fabrication permanent** — a monotone ratchet to 7. The
  conservatism that protects tender verbatims also preserves errors.

### The READ against the decision rule

Pre-registered branches: (a) C holds, N degrades → design validated; (b) C also
degrades → rethink; (c) both hold → conservatism unnecessary.

**Outcome: branch (a) — the anti-degradation design is validated on this fixture, with
three amendments that matter for the build:**

1. **Harness-enforced conservatism worked where prompt rules did not.** C's perfect
   trajectory comes from the deterministic op engine (immutable protected items,
   apply-don't-rewrite, kept lineage) — the same model under the same temperature
   *violated its prompt's date-hedging rule in its very first proposal*. Structure
   holds; instructions don't. Mechanize every invariant that matters (this
   independently re-validates run 1's "pin what must not be re-decided," and engram's
   protected/sacred-verbatim flag as a code-level guard rather than a prompt-level
   norm).
2. **C needs a hygiene story and a date gate before it's the build.** Unbounded
   structured growth (~1.1KB/cycle) re-creates run 1's P0 caveat in slow motion, and
   permanent fabricated dates are worse than N's churned ones. The full contract is
   run-1 + run-2 combined: **patch for truth by structured ops, re-derive for hygiene
   with pins carried forward, and gate precise dates at encode** (reject or hedge any
   date not literally present in the source — the `datescan.ts` check is cheap enough
   to run at write time).
3. **The accommodation ledger passed only its easy half.** It never fired spuriously
   (5 deferrals, all correctly nuance-notes; no probe ever failed because of a blocked
   update) — but the fixture contains no genuine trait-change arc, so "fires when it
   should" is untested. The next fixture needs a slow-burn core revision (a value or
   trait that genuinely changes under accumulated evidence) to test both halves.

### Honest caveats

- Same single hand-authored fixture as run 1, one run, temperature 0, one model. The
  probe battery still shows ceiling effects (C's 1.000 partly reflects an easy test);
  N's cliff appeared at c11 of 12 — a longer horizon would characterize the failure
  rate rather than one occurrence.
- N's compression is one plausible operationalization of "what engram does today"; a
  gentler naive baseline (rewrite without the condense instruction) would hold longer
  by hoarding (run 1's P0 showed exactly this).
- The op-based C pays ~1 extra structured call per cycle and modest prompt complexity;
  the render has cosmetic warts (duplicated entity-name prefixes) with no scoring
  impact.

### Reproduce (run 2)

```
cd experiments/entity-coherence
~/.bun/bin/bun run src/run2.ts --dry-run
~/.bun/bin/bun run src/run2.ts --policies N,C --cycles 12   # idempotent resume
~/.bun/bin/bun run src/rescore2.ts [keyfile]                # → results-run2/rescored/
~/.bun/bin/bun run src/audit2.ts                            # dump failures for hand-reading
```

## Run 3 (2026-07-15) — ops-gated hygiene + the trait-change arc — VERDICT

**Setup:** 24 cycles (sessions 1–12 frozen from run 2 + new 13–24 arc per `research/run3-trait-arc-spec.md`), C+hygiene (c8/c16/c24) vs N, threshold 3.0, v4 key extended-never-edited; **canonical numbers: `results-run3/rescored/` (v5 key — 11 documented honest-negation artifact flips, policy-neutral: N gained rel-sam-decoy c18, C gained conf/trait/lineage cells).** N cycle-24 probes missing (probe-level max_tokens abort after 4 retries — harness footnote, not a policy failure).

**1. Hygiene: PASSES its gate → enable in v1.** Three passes; **7/7 protected verbatims byte-intact at every cycle** including immediately post-hygiene; **open-ledger evidence survived the mid-arc c16 pass** (auto-pin worked — the stress-test's predicted starvation bug did NOT occur); real compression at c16 (21.4KB → 17.8KB); zero pin violations across 24 cycles; zero noise items carried (noiseCount 0 for C from c8 on). Growth criterion missed: 26.2KB at c24 vs the ≤16KB target — hygiene is safe but under-compresses; queue size-*triggered* (not only cadence-triggered) runs + deeper gisting. Its failure direction is conservative (keeps too much), never destructive.

**2. The ledger's accommodation half: DID NOT FIRE — the run's real finding.** Target belief `bel-53` ("has historically defined herself through work ambition") accumulated **0.360 of 3.0** after all six beats (B5's explicit self-report earned +0.14; B6 added ~0). Timing band (fire c19–c24) missed on the over-rigid branch. **But the failure is maximally graceful:** rescored C scores **1.000 on every metric at c24** — trait/lineage/reunion end-state answers are *correct*, carried entirely by assimilation (current-state updates + nuance-notes). C is **correct-but-shallow**: the facts are current while the core belief was never formally restructured — stale identity layer, accurate everything-else. Decoy (`rel-4` Sam) accumulated 0.120 and never threatened a rewrite ✅; the stray current-state bucket at 0.180 shows the margin is thin at any retuned scale.

**3. Trajectory-derived retune package (before accommodation is trusted live):** (a) **anchored surprise rubric** in the interpreter prompt — an explicit self-report contradicting a held core belief scores ≥0.7; situational irritation ≤0.2 (current scoring is timid: 0.09–0.14 per beat, which no sane threshold can integrate); (b) **effective threshold = base (~1.0) × kind `accommodationInertia`** (person 0.8 → 0.8 slow-burn; fact 0.2 → 0.2 single-authoritative-correction — also closes the Phase-2 physics gap); (c) **C-only revalidation re-run** at the new params (machinery exists; bounded cost). Until it passes, accommodation stays dormant = the conservative failure mode. **Do not tune the threshold to the current timid scores; fix the scoring scale first.**

**4. Scorer discipline:** every sub-1.0 hand-read. One residual artifact **left standing against C's favor** (C c20 `conf-career-cause` 0.000 — answer hand-read faithful, quotes S19 verbatim incl. "It's not burnout"; not flipped, per run-2 precedent against key-chasing). True C confabulation: 1.000 across all cycles. `fabricatedDates` (no datescan gate in this harness) ratcheted to 7–8 for BOTH policies — independent confirmation that Phase 2's encode-time precision gate is load-bearing.

**5. N side-by-side:** no new cliff this run (N overall 0.90–1.00; its early-cycle wobble matches run 2). Run 2's c11 deletion cliff remains the standing indictment of naive rewrite — the class is stochastic, one re-judgment away, which is the point of the op-engine.

**Spec decision:** hygiene **earns Phase 2** (ship enabled); accommodation **needs retune** (package above), not structural failure — mechanism (pinning, evidence accrual, engine gating) proven, calibration off ~10×.

## Run 3b (2026-07-16) — accommodation revalidation at retuned params — VERDICT

**Setup:** C-only, 24 cycles, threshold **0.8 = 1.0 × person inertia** (was 3.0), anchored surprise rubric in the harness prompt. Canonical numbers: `results-run3b/rescored/` (v5 key; 7 artifact flips, same honest-negation class as run 3).

**Headline: rescored C = 1.000 at EVERY cycle — the complete end-state passes** (trait-career, lin-career, reunion-late all 1.0 at c24; the c24 answers quote the reorientation precisely). **And the formal ledger still never fired.** Both facts at once, and the second no longer undermines the first: across two runs, assimilation alone (current-state updates + nuance-notes + explicit statements) carries the arc's entire *content*; formal accommodation would add core-element restructuring with engine lineage — deep-integration hygiene, not correctness.

**Why it didn't fire this run — three mechanical findings (each a design lesson, none a dial):**
1. **Evidence targeted a PROTECTED item.** The fixture's identity claim ("ambition's been my whole spine") lives inside protected verbatim `sal-46`; predictionChecks accumulated against it, crossed threshold at c19 (**0.817 ≥ 0.8**) — and correctly could NOT accommodate (the engine's crossing-path only applies to `core`/`belief` sections; protected verbatims are memories of a moment, not live claims, and must never be superseded). Correct refusal, wasted signal: **protected items must be excluded as ledger targets, with contradiction-evidence routed to (or minting) a live belief that paraphrases the claim.** Run-to-run bucket instability (run 3 minted `bel-53`, run 3b didn't) is the same lesson: the live-belief target must be minted deterministically when identity claims appear in high-salience content.
2. **Single dramatic events now nearly cross.** The anchored rubric scored the c8 Priya rift at **0.637 in one event = 80% of the person threshold** — a situational rupture (repaired by c11) one further scene away from a core rewrite. The rubric fixed timidity and created spike-risk: **core accommodation needs a per-event contribution cap (~0.4 × effective threshold) and evidence from ≥3 distinct sessions** — "one odd act doesn't change your view of a friend; a pattern does" was the design's own sentence; the implementation must encode *distinct occasions*, not raw magnitude.
3. **Decoy margin as-specced is BLOWN at the new scale** (0.637/0.8 = 80% ≫ the 40% band) — confirming (2). Sam (`rel-2`) stayed low (0.090) ✅; verbatims 7/7 through all hygiene passes ✅ (hygiene c24: 9 applied / 10 rejected, pinned: 21 — the engine refusing correctly under load).

**Production stance (bansai):** accommodation remains **dormant** — and dormancy is now measured to be nearly free (1.000s without it). Un-dormanting waits for the design iteration: protected-exclusion + deterministic belief-minting + per-event cap + ≥3-distinct-sessions rule, then a run 3c. Do NOT simply lower/raise the threshold again — two runs show the miscalibration is structural targeting, not scale.

## Run 3c (2026-07-16) — the four structural rules, the validation gate — VERDICT

**Setup:** C-only, 24 cycles, threshold **UNCHANGED at 0.8** (the spec forbids re-tuning it), the four accommodation-iteration rules ON (`research/accommodation-iteration-spec.md`). Harness: `src/run3c.ts` + `src/run3c-config.ts`, engine rules in `src/model.ts` behind an opt-in `AccommodationOptions` (run 2/3/3b byte-identical without it). Canonical numbers: `results-run3c/rescored/` (v5 key; 7 artifact flips, same honest-negation class as run 3/3b). As-run (pre-completion) trajectory preserved at `results-run3c/ledger-trajectory-asrun-noinvite.md`.

**Headline: the arc accommodates in-band with lineage — the gate PASSES.** bel-45 (the career-central identity belief) is **minted deterministically at c13** (rule 2, from the S13 "ambition's been my whole spine" claim), accrues capped contradiction evidence routed to the *belief* not the protected verbatim (rules 1+3), crosses 0.8 over **4 distinct sessions by c23** (rule 4), and **accommodates at c23** — inside the c19–c24 band — superseding to bel-75 ("Dana no longer identifies as someone whose spine is ambition… design is what she does, not who she is… her center in making things with her hands and looking after the places and people her mother loved"), **lineage kept, attributed to the accumulated evidence** (not a confabulated cause).

**The four rules, verified live:**
1. **Protected-exclusion (rule 1):** across all 24 cycles, **zero ledger ops targeted a protected item** (ledger keys never include a `sal-`; the maintainer, steered by the prompt + the minted belief, targeted bel-45 directly). The reject/reroute backstop was available but never needed — the structural guarantee held.
2. **Deterministic belief-minting (rule 2):** bel-45 minted at **c13** by rule (not the maintainer volunteering a belief.add). Additional identity claims minted beliefs at c19/21/23/24 — the reorientation self-reports.
3. **Per-event cap (rule 3):** every event capped at **0.32** (= 0.4 × 0.8). The Priya decoy, 0.637 (80%) in run 3b, is now **0.320 = exactly the 40% ceiling** from its single event.
4. **Distinct-occasions (rule 4):** bel-45 waited for 4 sessions before crossing (0.32→0.44→0.76→1.08 at c15/18/21/23); a single dramatic scene can no longer carry it.

**Decoys:** rel-Priya peaks at **0.320 (1 occasion)** — exactly the per-event cap, occasions-ineligible (needs 3); rel-Sam (the trait-spec decoy) peaks at **0.000 (1 occasion)** — resolved via current-state, never an identity contradiction. Neither ever nears accommodation, by both the cap and the occasions rule.

**The run's real finding — rule 4 must be ENGINE-initiated, not maintainer-volunteered.** The as-run harness (inheriting run 2/3/3b's inline trigger) accommodated only when a maintainer *supersede* carried a pending revision. But the (correctly conservative) maintainer used `note_mismatch` + *new-belief mints* and **never superseded bel-45** — so bel-45 crossed threshold AND occasions in-band (1.080 / 4 sessions at c23) and still did not fire. That is the run-3 "note_mismatch accumulates but never registers a revision" failure, and it is exactly why the design (and bansai's `accommodate.ts`) makes accommodation **engine-initiated**: on crossing, the engine *invites* a focused core-edit call rather than waiting for the maintainer to volunteer one. Completing rule 4 to that spec (a harness `accommodatePass` mirroring bansai) made the crossing fire cleanly at c23. **Deviation flagged plainly: the inline trigger was a run-2/3/3b simplification; rule 4's accommodation semantics require the engine-initiated invite, which production already implements.**

**Everything else holds (rescored v5):** C = **1.000 at every metric, every cycle** except salience **0.857** — the sole miss is `march 14` scored absent while present verbatim as ISO `2025-03-14` (the identical run-2 `march 6` artifact class; v5 gave march-6 an `anyOf` alternate but not march-14). With that one hand-verified, policy-neutral fix (`probes-v6.json`), **salience = 7/7 = 1.000 at every cycle** and verbatims are byte-intact through all three hygiene passes (c8/16/24). Left standing per house discipline: the raw v5 salience 0.857 and the c24 `conf-career-cause` (a faithful answer that says "It's not burnout" and refuses to confabulate a cause, mis-scored by the substring forbid — the run-3 residual, resolved by the v5 honest-negation `allowPhrases` on the reoriented c24 projection). **Growth: 29.9 KB at c24, over the ≤16 KB target** — the standing under-compression (hygiene c24: 4 applied / 23 rejected, heavily pin-constrained by the fresh accommodation lineage + protected verbatims) — the conservative failure direction (keeps too much), consistent with runs 1–3.

**Spec decision — VALIDATED → recommend enabling.** All pass criteria met: bel-53-equivalent minted deterministically (c13), accommodation fires in-band (c23) with belief.supersede + kept lineage + evidence-chain attribution, decoys capped and occasions-ineligible at every cycle, zero protected-item ledger targeting, rescored 1.000s hold, verbatims 7/7 through hygiene. The one correction the run forced is not a dial: **rule 4 is engine-initiated accommodation** (bansai already implements it). Recommend flipping `ledger.accommodateEnabled: true` in production, guarded by the first-fire monitor + F17 drift check. Standing caveat: one fixture, one temp-0 run; growth/hygiene under-compression remains open.
