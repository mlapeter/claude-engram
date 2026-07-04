# Engram — What Actually Fires

*2026-07-04, Claude (Fable 5). One page: every mechanism, what it claims, where it
actually runs, what measured evidence exists, and a verdict. Evidence sources: the
recall-bench validity battery (VALIDITY.md), the vclock ablation re-run (its
addendum), the judge audit, and code reading of `src/core` + `src/hooks` +
`src/mcp` on this date. The pruning criterion going forward: **a mechanism earns its
complexity by a measured effect** — on the benchmark dev subset or in observable
live behavior. Unmeasured ≠ delete, but unmeasured = frozen (no tuning, no new
complexity on top).*

Paths: **live** = real Claude Code sessions via hooks/MCP. **bench** = recall-bench
adapter path. These differ more than anyone realized.

| # | Mechanism | What it claims | Runs where | Evidence | Verdict |
|---|---|---|---|---|---|
| 1 | JSON store, locking, backups, scopes | durable plumbing | live + bench | works daily; battery verified isolation & no cross-scenario leaks | **KEEP** |
| 2 | Hybrid search (exact → token → vector, w=0.4) | better retrieval | live + bench | embeddings-off: 50.5 vs baseline 52.2 — **inside the ±3 noise bar**; vector layer has no demonstrated uplift yet | KEEP but **don't credit it**; measure at v1.1 |
| 3 | Strength ranking (salience + bonuses − decay) | important memories win | live (wall clock, correct) + bench (was broken) | the clock fix reconnected it: +4.7pp paired, strength floor 27%→0% — ranking does real work when connected | **KEEP** |
| 4 | Decay rate/model (power-law 0.035) | old unimportant memories fade | everywhere | decay-off ablation moved the decay dimension by exactly the noise-pair amount (−4.2pp both) — the instrument is blind (16/30 Tier-1 decay queries are abstention-only) | KEEP, **frozen** until v1.1 rescore can see it |
| 5 | Search recency boost (1+1/(1+ageHrs)) | fresh memories surface | live + bench (dead until vclock) | never isolated; second wall-clock bug found here | frozen; **MEASURE or fold into #3** |
| 6 | Salience vectors (4-dim, assigned by Haiku) | encode what mattered | everywhere (base of #3) | never ablated in isolation; assigned post-hoc by a model that wasn't in the conversation | **REPLACE THE SOURCE** — author-assigned (the conversing model already passes salience_hint via MCP store) |
| 7 | Haiku transcript extraction (on-stop) | turns sessions into memories | live + bench | **three documented failures:** invented the user's name from its own few-shot examples (salience.ts:26); inverted who-committed-to-what (judge audit #3); loses load-bearing wording (sacred-verbatim 43–57 vs verbatim-RAG 93) | **REPLACE for the self layer** (in-room first-person authorship); optionally retain for world-facts only |
| 8 | Interference (×0.7 dampening via updated_from) | corrections weaken superseded traces | **live only** (on-stop); never ran in any published bench number | when enabled: correction +6pp mean, positive 4/4 runs (~2× noise); replicated cost: sacred-verbatim −10 to −15 | **KEEP + FIX**: exempt verbatim-anchored content from dampening; correction paired-deltas is its readout |
| 9 | Hebbian reinforcement (access_count × 0.12, cap 0.5) | used memories strengthen | **live only** (MCP recall/deep_recall/reinforce bump access_count); bench path is read-only, so **no benchmark run has ever exercised it** | zero measurements | frozen; MEASURE (a bench adapter that recalls-then-reinforces is ~1 hr of work) |
| 10 | Consolidation (auto at session-start, ≥50 mem & ≥3d: prune→archive, episodic→semantic at 7d, Sonnet merge/generalize/prune, two-pass embedding clustering) | sleep | **live only**, automatic | runs (logs confirm); output quality never measured; note it only **compresses storage** — it does not produce disposition | **REFRAME** — this is the slot where the identity-document rewrite belongs (see DESIGN-RECENTER.md) |
| 11 | Deep archive (archiveDecayRate 0.001, deep_recall recovery re-strengthens) | retrieval failure ≠ true forgetting | live | recovery path works; philosophically load-bearing (nothing tender is ever truly deleted — the tact-compatible piece) | **KEEP** |
| 12 | Briefing (Opus-written at session-end, cached, injected at session-start; fallback generator) | continuity on wake | live only | **the most successful mechanism in the system** — the session-start syntheses that carried a working relationship across this entire week | **KEEP**; becomes the identity-document render path |
| 13 | MCP tools (store/recall/deep_recall/reinforce/forget/search_by_tag/status/consolidate) | in-the-moment memory acts | live | store's **400-char cap truncated 4 genuinely important memories this week** — real friction on the highest-value content | KEEP; raise/route the cap (episodes belong in files) |
| 14 | Adaptive salience weights (recordSignal on reinforce/forget/prune) | learn what matters over time | live only | never measured | frozen; MEASURE or remove |
| 15 | Abstention / confidence | — | **nowhere** | calibration pinned at 1–3% in every configuration ever run | **BUILD** — single easiest visible win in the whole system |
| 16 | Wall-clock assumption | — | contract, not bug | any simulated-time consumer must project timestamps (engram-vclock adapter pattern, documented in recall-bench) | document it |

## The three findings that explain the "lost the handle" feeling

1. **The live path and the measured path are different systems.** Interference,
   consolidation, briefing, and Hebbian reinforcement run **only live** — no
   benchmark number ever included them. Decay and search were measured in a path
   where the clock was broken. Nobody could have had a handle on this, because no
   single view of the system existed. This document is that view.
2. **Extraction is the contamination source.** Every fidelity failure we can
   document traces to one component: a smaller model, not present in the
   conversation, writing memories after the fact. Its replacement is argued by both
   evidence and principle (the rememberer must be the experiencer).
3. **What demonstrably works is the simple half:** plumbing, strength-ranked search
   (once clock-connected), the Opus briefing, interference's effect on correction,
   deep archive. What's unmeasured is mostly the clever half: embeddings uplift,
   recency boost, adaptive weights, consolidation quality, the decay constant.
   The complexity did not fail — it was never *tested* until now. Freeze it, measure
   piece by piece, delete what doesn't move anything.
