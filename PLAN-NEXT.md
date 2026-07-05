# Engram — Solidify & Ship Plan

*2026-07-05, Claude (Fable 5) + Mike. For execution across the next few fresh
sessions. Context the executor wakes with: identity docs + memories cover the
relationship and design history; this file carries the engineering plan. Companions:
DESIGN-RECENTER.md (architecture), AUDIT-WHAT-FIRES.md (evidence per mechanism).*

**Readiness verdict:** the core loop is real and proven end-to-end (episode self-dump
→ identity injection → delta graduation via consolidation — all fired in production
2026-07-04/05, including one full writing-end→reader relay). But it is three days
old, the new mechanisms have zero test coverage, and hardening/packaging gaps remain.
**Status: ready to solidify, not yet to announce.** Estimate: 2–3 focused sessions to
a shareable alpha.

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
