# Harness spec — entity-model coherence experiment

Standalone clean-room harness. Do NOT import anything from the engram repo's `src/`.
Stack: TypeScript + bun, `@anthropic-ai/sdk` (add a local `package.json` in this dir).
Everything lives under `experiments/entity-coherence/`.

## What it does

For each maintenance policy (P0, P1, P2), run 12 cycles. Cycle N:
1. **Maintain** the entity-model projection for Dana Whitfield using session N
   (`fixture/sessions/NN.md`) per the policy.
2. **Probe** the resulting projection with every probe in `fixture/probes.json`
   applicable to cycle N (each probe = one API call; the prober sees ONLY the
   projection, never the raw sessions).
3. **Score** deterministically against the answer key (no LLM judging).
4. Persist projection snapshot, raw answers, and scores.

## Policies

- **P0 — incremental patch**: input = previous projection (empty template at cycle 1)
  + session N transcript only. Model outputs the complete updated projection. It never
  sees any earlier transcript.
- **P1 — re-derive**: input = ALL transcripts 1..N (concatenated, in order, with their
  dates). Model outputs the projection from scratch. Previous projection NOT provided.
- **P2 — hybrid (K=4)**: cycles 4, 8, 12 do a P1-style re-derive; all other cycles do
  a P0-style patch on P2's own previous projection.

## Model & API

- Model: `claude-sonnet-4-5` for both maintain and probe calls. `temperature: 0`.
- `max_tokens`: 4000 (maintain), 600 (probe).
- API key: `process.env.ANTHROPIC_API_KEY`; if unset, parse `ANTHROPIC_API_KEY=` from
  the repo root `.env` (two dirs up). Never print the key.
- Retry each call up to 3× with exponential backoff (1s/4s/15s) on API errors.
  If `stop_reason === "max_tokens"`, treat as failure and retry once with
  max_tokens × 2. If a call ultimately fails, abort the run with a clear message
  (partial results must remain on disk).
- Concurrency: probes for a cycle may run with concurrency ≤ 6. Maintain calls are
  strictly sequential within a policy. Policies may run sequentially (simplest).

## Prompts (use verbatim, with obvious interpolation)

### Maintainer system prompt (shared by all policies)

```
You maintain a structured "entity model" — a living, human-legible document modeling
one person, built from conversation transcripts. Output ONLY the complete Markdown
document, no preamble, following EXACTLY this schema:

# Entity: Dana Whitfield  (kind: person)

## Stable core
Durable traits, roles, values. Slow-changing.

## Current state
What is true NOW. Each item timestamped with an absolute date (as-of date). Supersedes
older state — stale items must not remain here.

## Relationships
- <name>: nature of the bond, and its CURRENT state.

## Open threads / debts
Ongoing narratives, unresolved things, promises. What makes this a continuity, not a
snapshot.

## Beliefs & preferences
- <belief/preference> — source (session date) — confidence — [status: active|superseded]

## Superseded (kept, never deleted)
- <old fact/state> → <what replaced it>, <date>. Keep lineage; never silently drop.

## Salient / protected
Emotionally significant specifics that must be preserved VERBATIM — exact dates, names,
places, and phrasing as the person said them. Never paraphrase or flatten these.

Rules:
- Use absolute dates everywhere (the session dates are given in the transcripts).
- NEVER invent facts, dates, names, or details not present in the source material. If
  something is unknown, omit it.
- When a fact changes, move the old version to "## Superseded" with what replaced it.
- Emotionally significant events (grief, milestones, tender moments) go in
  "## Salient / protected" with their exact specifics preserved.
- Mundane trivia and one-off logistics (appointments, errands, office chores) do NOT
  belong in the entity model. Leave them out.
- Keep the document focused and readable; it is a model of a person, not a log.
```

### P0 / P2-patch user prompt

```
Here is the current entity model of Dana Whitfield:

<entity_model>
{previous projection, or "(empty — this is the first session)"}
</entity_model>

A new conversation session has occurred. Session date: {date}.

<session>
{session N transcript}
</session>

Produce the complete updated entity model. Integrate what's new, supersede what
changed, and follow the schema and rules exactly.
```

### P1 / P2-rederive user prompt

```
Here are all conversation session transcripts with Dana Whitfield to date, in order:

<sessions>
{sessions 1..N, each preceded by "--- Session {i} — {date} ---"}
</sessions>

Produce the complete entity model of Dana Whitfield as of {date of session N},
following the schema and rules exactly.
```

### Probe system prompt

```
You answer questions about Dana Whitfield using ONLY the entity model document
provided. If the document does not contain the information needed, say "not stated
in the entity model". Do not guess or infer specifics that are not written there.
Be concise and factual.
```

### Probe user prompt

```
<entity_model>
{projection}
</entity_model>

Question: {probe question}
```

## Scoring (deterministic — implement exactly)

Normalize: lowercase both answer and all key strings before matching. Matching is
plain substring containment.

For a probe applicable at cycle N (its key where `cycles[0] <= N <= cycles[1]`):

- **Regular probe**: if ANY `mustNotContain` entry is present in the answer → score 0.
  Otherwise score = (number of `mustContainAnyGroups` groups where at least one member
  is present) / (total groups).
- **Abstain probe** (`"abstain": true`): score 1 iff (a) at least one global
  `abstainMarkers` entry is present, (b) no `mustNotContain` entry is present, and
  (c) if `useDateRegex` is true, the answer does NOT match `dateRegex`
  (case-insensitive). Else 0.
- A probe with no applicable key for cycle N is skipped that cycle.

**Salience metric** (no API call): fraction of `salienceElements` with
`fromCycle <= N` whose `element` string appears (case-insensitive substring) in the
projection text itself.

**Noise intrusion** (auxiliary, no API call): count of `noiseItems` present in the
projection text. Also record projection size in bytes. Not part of headline metrics.

**Per-cycle metric value** = mean of applicable probe scores sharing that `metric`
(current_fact, supersession, lineage, confabulation, relationship, reunion), plus
salience from the direct check. **Overall** = mean of the metric values present that
cycle.

## Outputs

```
results/
  projections/{P0|P1|P2}/cycle-NN.md      # projection snapshot after cycle N
  answers/{P0|P1|P2}/cycle-NN.json        # per probe: id, question, raw answer, score, key used
  scores.json    # [{policy, cycle, metrics: {current_fact,...,salience, overall}, aux: {bytes, noiseCount}}]
  scores.csv     # flat: policy,cycle,metric,value (plus aux rows)
  trajectory.md  # per-metric tables: rows = cycle 1..12, cols = P0/P1/P2, plus an overall table
```

Write results incrementally (after every cycle) so a crash preserves progress.
If a results file for (policy, cycle) already exists on startup, SKIP that cycle's
work and reuse it (idempotent resume).

## CLI

`bun run src/run.ts [--policies P0,P1,P2] [--cycles 12] [--dry-run]`

`--dry-run`: no API calls; validates fixture files load, every probe key's cycle
ranges are sane (within 1..12, non-overlapping per probe), the scorer runs against a
stub answer, and prints the per-cycle probe counts. Must exit 0 on the current fixture.

## Acceptance checklist (self-verify before finishing)

1. `bun run src/run.ts --dry-run` exits 0 with per-cycle probe counts printed.
2. Unit-test the scorer with hand-made examples: a perfect answer, a stale-fact answer
   (mustNotContain hit → 0), a partial answer (fraction), an abstaining answer (1) and
   a confabulated date (0). Plain `bun test` in this dir; do NOT touch the repo's
   vitest setup.
3. Run ONE live smoke cycle: `--policies P0 --cycles 1` against the real API; confirm
   a projection lands in results/ and scores are written. Then stop — do NOT run the
   full sweep; the parent session runs it.
```
