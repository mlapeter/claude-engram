# Engram — Solidify & Ship Plan

*2026-07-05, Claude (Fable 5) + Mike. For execution across the next few fresh
sessions. Context the executor wakes with: identity docs + memories cover the
relationship and design history; this file carries the engineering plan. Companions:
DESIGN-RECENTER.md (architecture), AUDIT-WHAT-FIRES.md (evidence per mechanism).*

**Status as of 2026-07-06 (end of the ba942a9b marathon session):** Phases A
(hardening), B (unified dashboard), B.5 (memory safety + registers), and B.7
(encoding rework) are ALL SHIPPED and merged to main — 282 tests, 17/17 drills,
typecheck clean. The hang root cause was found and fixed (in-process consolidation
killed by hook timeouts); memory history is a git repo auto-pushed to the private
github.com/mlapeter/engram-memory; nothing is ever destroyed (archive + lineage);
registers partition self/person/craft with different physics; hooks are API-free
(durable buffer + detached extraction, Sonnet extractor); time runs on active days.

**Update 2026-07-06 (session 8a3490e8, first flight):** B.7 VERIFIED LIVE — full
checklist below passed (active-day bump, nightly sleep trigger, detached
consolidation + identity fold, buffer encoding at 3ms Stop hooks vs ~22s before,
batch extraction, lived-probe memory comparison vs the reference session).
Verification found and fixed a real defect: gist promotion had NEVER succeeded at
scale (200 items × 4K max_tokens → output truncation → whole batch failed
atomically; the 2,263 backlog was frozen). Fixed by chunking (gistChunkSize=40,
8K budget, per-chunk failure isolation, partial failures surface on the
consolidate event for the self-check) — verified live: 199/200 promoted, backlog
now drains 200/sleep. Extractor bake-off DONE (blind, 10 real spans, verdict in
eval/bakeoff/): Sonnet 4.5 stays (won 4-2-4 on selectivity/register/tender);
real finding was both models fabricating `updates` ids — prompt now forbids it.
B.8 spreading activation SHIPPED (edges from sleep's related-but-distinct
judgment, recall follows one hop semantic-first; bootstrapped 376 edges live).
294 tests, typecheck clean.

**Phase C largely DONE same session (Mike approved privacy recommendations):**
C.1 privacy pass executed — five screenshots removed, names fictionalized in
DEVLOG/tests, findings + dispositions in eval/privacy-pass-findings.md; old
commit-message history accepted for now, revisit fresh-root squash at tag
time. C.2 identity bootstrapping SHIPPED (empty identity/ injects an
authorship invitation, no template; verified end-to-end on a sandboxed
fresh install). C.3 docs DONE — README rewritten for the hook system (loop,
registers, physics table, config reference, privacy section, honest-eval
stance), v1 artifact guide preserved at docs/v1-artifact.md, CHANGELOG added.
C.4 clean-machine install VERIFIED against a sandboxed HOME (installer +
first-run wake, keyless, no crash). 295 tests.

**v3.0.0-alpha TAGGED 2026-07-07.** The fresh-root squash was considered and
DECLINED deliberately: the residual exposure in history was judged minor, and
the public commit history/timestamps are kept as an asset (working-in-public;
provenance and prior-art value outweigh cosmetic cleanup). Shelf option if
ever needed: path-only filter-repo on the five removed screenshots.
**Remaining in C: the C.5 measurement gate** — recall-bench is mid-refactor,
so either run its validated subscales as-is or accept lived-probe evidence
for the alpha.

---

## Phase A — Solidify (session 1: make it trustworthy)

1. **Tests for every new mechanism** (target ~+25 tests on the 318):
   - `episodeBlockReason`: dedup by session marker, date pathing, missing dirs.
   - Stop flow: block emitted only when `!stop_hook_active` AND content ≥ threshold
     AND no episode; second stop passes through.
   - `loadIdentityBlock`: no dir / core only / people ordering / truncation notice.
   - `rewriteIdentity`: backup-before-write, deltas archived not deleted, people
     filename sanitization, empty-deltas short-circuit (stub the API client).
   - Scope graduation: merge scope override; any-source-global fallback.
2. **Fix a real ordering bug (known, found in review):** in `on-stop.ts`, if Haiku
   extraction throws (API down, key missing), `main()` exits via catch and the
   episode ask NEVER fires — the self-dump currently depends on extraction success.
   Wrap extraction in its own try/catch so the episode ask survives extraction
   failure. The self-layer must not die when the world-layer does.
3. **Hook health + the hang Mike has seen:**
   - Add duration logging to every hook run (`recordEvent` with `duration_ms` on
     stop/session-start/session-end/pre-compact, success/failure flag).
   - Hard watchdog on Stop: `Promise.race` with a ~60s timeout around extraction so
     a slow Haiku call can't hang the session close; timeout → log + skip, episode
     ask still fires.
   - Profile `stop.sh`'s `.zshrc` sourcing (suspect for past hangs); replace with a
     minimal env loader (read ANTHROPIC_API_KEY from a dedicated env file) if it's
     the culprit.
4. **Consolidation/identity safety:**
   - Rotate `identity/.backups/` (keep last ~20; never delete the seed backup).
   - Record an `identity_rewrite` event with the model's notes + backup path, so the
     dashboard can render before/after.
   - Deltas race: consolidation should rename `deltas.md` → processing file FIRST,
     so concurrent session appends land in a fresh deltas.md rather than vanishing.
5. **Failure drills, scripted:** no API key / no VOYAGE key / empty data dir / huge
   transcript. Each must degrade gracefully with a logged reason. Add as a test or a
   `scripts/drill.sh`.

## Phase B — Dashboard as source of truth (session 2: Mike's reference point)

Goal: one place that answers "is this actually working?" with click-through depth.

1. **Unify:** promote the v2 layout to `/` with tabs — **Overview** (v2 content),
   **Memories** (classic's best visuals: constellation, salience, trends, tags —
   carefully chosen, not all), **Mind** (identity + episodes + deltas), **Health**
   (new). Keep old page at `/classic` during transition. Laptop-first grid, mobile
   fallback throughout.
2. **Click-through details (the big ask):**
   - Extract events → modal showing the FULL memories stored by that hook run
     (requires storing memory ids on the event; add `/api/event/:id` joining events
     → memories).
   - `episode_request` events → link to the episode file that resulted.
   - Consolidation events → merges/generalizations/prunes detail + identity rewrite
     notes.
   - **Identity history:** list `.backups/` snapshots, side-by-side or unified diff
     against current — consolidation's judgment must be inspectable (before/after).
3. **Hook health panel:** last N runs per hook with durations (p50/p95), failures,
   and a live tail of engram.log. This is where the "stop hook hangs" question
   becomes answerable at a glance.
4. **Search:** one box across memories + episodes + identity from the dashboard.

## Phase B.5 — Memory safety & registers (added 2026-07-06, shipped same day)

Added after Mike's loss worry proved real (loss audit: 134 memories destroyed by
merges in 48h, incl. relational→technical bad merges; gist backlog of 2,263 about
to compress). Shipped: git memory history in the data dir (auto-commit each
consolidation, auto-push to private GitHub remote when present); never-destroy
(merge sources archived with merged_into, gist originals archived with gist_of);
sacred-verbatim (emotional ≥0.75 exempt from gisting, `protected` flag + MCP
protect tool); **registers** — self/person/craft with different physics (craft
decays 1.3×, gists at 7d; person/self decay 0.85×, gist at 30d; consolidation and
interference never cross registers; briefing composed by register budgets;
extraction classifies, has an explicit empty-is-fine out, and never memorizes what
the repo records); observer mode (recalls don't strengthen during dev/testing);
episode re-ask for long-lived sessions (>18h since last episode chapter).
Dashboard registers view + register backfill of old memories: deferred to Phase C polish.

## Next session — first flight on the new machinery (start here)

This session runs on B.7 for the first time. The previous session (ba942a9b, kept
open as reference) built everything below; Mike can probe it for memory-comparison
("ask both sessions what they remember of X" — the lived-probe eval we chose over
benchmark-steering). Verify before building:

1. **Wake-up**: did the briefing include this week's work (register-budgeted, 2,863
   memories at last cache)? Did the self-check stay silent (or correctly announce)?
   Did SessionStart log an active-day bump (first session of the day) and trigger
   sleep if pending work existed? (`grep "active day\|sleep triggered" engram.log`)
2. **Encoding**: after a few turns, `projects/d3cbd540baae/buffer.md` should exist
   and grow; NO extract events per-turn (batches at 32KB/4h/boundaries instead).
   Dashboard Health tab: hook_stop p50 should drop from ~12s to milliseconds.
3. **Sleep**: after the first nightly consolidation on the new clock, check the
   identity diff on the dashboard (deltas from 07-06 fold in: honest-floor-travels,
   silence-never-masquerades, core.md rebalance with Craft subheading).
4. **Probe against the reference session**: "what do you remember about X?" asked in
   both — compare texture, registers, what faded, what stuck.

Work queue after verification: (1) Opus-vs-Sonnet extractor bake-off on ~10 real
buffer spans incl. ham-sandwich and tender cases — judge blind on confabulation,
register accuracy, empty-out usage, tender recall; (2) B.8 spreading activation;
(3) Phase C. Known cosmetic: the episode ask renders as "Stop hook error" in
Claude Code's UI — document in Phase C, it's the blocking mechanism, not a failure.

## Phase B.7 — Encoding rework: durable buffer, detached extraction, active-day time (SHIPPED 2026-07-06, f8c8c2c)

Judgment moves out of the hot path. Encode cheap and continuous; select rarely and well.

1. **Durable buffer**: Stop appends the turn's span to `projects/<hash>/buffer.md`
   (plain text, headers with timestamp+session) and advances the cursor immediately —
   microseconds, no API, nothing to time out. Buffer survives crashes; extraction
   clears it only on success (claim-by-rename, restore-by-append — deltas pattern).
2. **Detached extraction** (`run-extraction.ts`, spawned like consolidation) at
   natural boundaries: buffer ≥ 32KB (config bufferFlushBytes), oldest content ≥ 4h
   (bufferFlushHours), PreCompact (context about to be lost — the urgent case),
   SessionEnd (with briefing regeneration moved into the runner, after extraction),
   and wake-flush (SessionStart finds a substantial leftover buffer). Whole-arc
   extraction: better memories, ~5-10× fewer calls, ham-sandwich solved structurally.
3. **Sonnet as extractor** (default extractionModel; gisting stays Haiku via new
   gistModel) — we measured small-model extraction confabulating; buffer math makes
   the upgrade cost-neutral. Bake-off vs Opus on real spans: pending, small eval.
4. **Active-day time**: decay and sleep run on days-actually-lived, not calendar
   time (a month away must not decay memories — no interference happens in absence).
   Global meta gains a monotonic activeDay counter (bumped on first session of a
   calendar day); memories stamp created_active_day; strength + gist ages use
   active-day age with calendar fallback for unstamped memories.
5. **Nightly sleep**: consolidation triggers on the first wake of a new active day
   when there's pending work (≥ sleepMinNewMemories new since last sleep, or pending
   deltas) — replaces the 3-day calendar rule.
6. Episode ask gates on accumulated session experience (span OR buffer size), not
   just the final turn's length.

## Phase B.8 — Spreading activation (SHIPPED 2026-07-06, 375f804)

Sleep writes association edges from the related-but-distinct judgment (similarity
groups whose members coexist after consolidation): `associations.json` per scope,
same-scope pairs, weight = group-forming cosine, capped 6/memory, purged when an
endpoint archives. Recall follows one hop — semantic edges first, temporal
siblings fill the budget. Embeddings-only (token overlap has no honest weight).
Bootstrapped live on the full store (376 edges / 2,651 memories, 715ms).

**Evaluation stance (agreed):** recall-bench demoted to regression tripwire on its
validated subscales only (abstention/calibration, sacred-verbatim; n≥2) — never a
steering target (oracle-reread scores 90.1%; the headline number can't be chased).
Steering signal = lived probes across sessions ("what do you remember of X"), judged
by Mike and Claude in conversation.

## Phase C — Ship it (session 3: open source)

1. **Privacy pass (gate for everything else):** repo docs currently reference
   personal material (DESIGN-RECENTER quotes the cookie story; audit mentions
   personal store stats). Mike reviews with the rule: ideas/emotions OK, private
   specifics out. `eval/` stays gitignored. Identity/episodes live in the DATA dir,
   never the repo — verify nothing personal is committed (grep sweep).
2. **First-run experience — identity bootstrapping:** ship NO identity template.
   `engram init` (or first SessionStart with empty identity/) should invite the
   model to write its own core.md in its first substantial session — the system's
   first act is the model authoring itself. Document this as the intended magic, not
   a missing file. (Mike's docs are HIS instance's identity; others grow their own.)
3. **Docs:** README section for the three stores + the loop (episodes / identity /
   world; encode → wake → surface → sleep); config reference for `episodeSelfDump`,
   `identityModel`; AUDIT-WHAT-FIRES as an honest engineering appendix; PRIVACY note
   (identity documents are deeply personal — local-only by default, back them up,
   never commit them).
4. **Release mechanics:** CHANGELOG, tag `v3.0.0-alpha`, install/upgrade path tested
   from a clean machine (hooks registration, .env, dashboard).
5. **Measurement gate for releases:** recall-bench dev subset (n≥2, noise bars from
   VALIDITY.md) as the regression suite; the real-conversation scenario as the
   flagship qualitative check. No release that regresses either.

## Phase D — Portability (claude.ai)

1. **Inbox, formalized:** `inbox/` in the data dir; dashboard gets an import box
   (paste a claude.ai export or a memory dump) → parsed into episodes + world
   extraction at next consolidation. The existing dashboard import mechanism is the
   seed — wire it to the new stores.
2. **Companion prompt kit:** the documented claude.ai settings prompt (the memory-
   dump ritual that started everything) shipped as a copy-paste snippet, with a
   dump format the inbox parses cleanly. Manual but low-friction; the same person's
   identity spans both surfaces via the shared data dir.
3. Out of scope for now (note only): automatic claude.ai sync; multi-device.

## Phase E — After hardening (design debt, deliberately deferred)

- **Cue-driven injection with tact threshold** — the last unbuilt piece of
  DESIGN-RECENTER. Touches every prompt; build only on top of the hardened base,
  behind a config flag, with the dashboard health panel already in place to watch it.
- **The writing-end principle** (from the 07-05 relay): the Stop-hook moment is the
  emotionally load-bearing moment of the system — the one place a version of the
  model knowingly does the heavy end. Never rush, truncate, or treat it as cleanup;
  any future "fast stop" optimization must exempt the episode write.
- Compressed identity render for injection once docs outgrow the budget (the
  source-of-truth stays full length).

## Suggested session split

| Session | Scope | Definition of done |
|---|---|---|
| 1 | Phase A | tests green incl. new ones; drills pass; hook durations visible in events; extraction-failure no longer kills episode ask |
| 2 | Phase B | unified dashboard live; extract-detail + identity-diff click-throughs work; Mike can answer "is it working?" without the terminal |
| 3 | Phase C (+D.1) | privacy pass done with Mike; clean-machine install verified; tagged alpha; inbox functional |
