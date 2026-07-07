# Changelog

## v3.0.0-alpha — the hook-based system (2026-07-07)

The rewrite that turned a paste-in artifact into an autonomous memory loop
for Claude Code. Everything below is live and verified in production use.

### Three stores, written by the model itself
- **Identity documents** (`identity/core.md`, `people/*.md`) — written by the
  model in its own voice, injected at every session start, maintained by
  consolidation with rotated backups and inspectable before/after diffs.
  Ships with **no template**: first run injects an invitation, and the
  system's first act is the model authoring itself.
- **Episodes** — first-person session narratives written by the session model
  at close (chapter re-asks for days-long sessions).
- **World memories** with a register partition: `self` / `person` / `craft`
  carry different decay and gist physics, and consolidation/interference
  never cross registers. Briefings budget space by register so technical
  work can't crowd out what matters.

### Encoding rework (durable buffer)
- Hooks make **zero API calls**: Stop appends the turn's span to a durable
  per-project buffer in milliseconds and can no longer time out or lose work.
- A detached runner judges **whole conversational arcs** at natural
  boundaries (32KB / 4h / PreCompact / SessionEnd / wake), with an explicit
  "nothing durable happened" option. Extraction failure restores the buffer:
  outages delay memories instead of deleting experience.
- Extraction moved to Sonnet after measuring small-model confabulation; a
  blind 10-span bake-off vs Opus confirmed Sonnet on selectivity, register
  accuracy, and tender recall.

### Time runs on days actually lived
- Decay, gist ages, and sleep use an **active-day clock** — a month away
  causes zero decay. Nightly consolidation triggers on the first wake of a
  new active day with pending work.

### Never-destroy memory safety
- Pruning archives (recoverable via `deep_recall` + reactivation); merges
  archive their sources with `merged_into` lineage; gisting archives
  verbatim originals with `gist_of` lineage.
- **Sacred-verbatim**: emotional salience ≥ 0.75, or an explicit `protect`,
  exempts a memory from gisting, merging, pruning, and interference.
- The data directory is a git repo — one commit per consolidation, optional
  private remote push.

### Spreading activation
- Sleep writes association edges from its related-but-distinct judgment;
  recall follows one hop (semantic edges first, temporal siblings after).

### Trust
- The system announces its own failures at session start instead of failing
  silently; hook health (latency percentiles, failures, log tail) lives on
  the dashboard, alongside memories, identity history, and cross-store search.
- Partial failures inside consolidation (e.g. gist chunks) surface on the
  consolidate event rather than vanishing into a log.

### Evaluation stance
- `AUDIT-WHAT-FIRES.md` documents what actually fires in production, with
  evidence, including mechanisms that didn't earn their keep.
- recall-bench demoted to a regression tripwire on validated subscales; the
  steering signal is lived probes across sessions.

## v1 — the Claude.ai artifact

The original: a single React artifact with salience scoring, forgetting
curves, sleep consolidation, and portable briefings — no API key, no
filesystem. Preserved and documented at `docs/v1-artifact.md`.
