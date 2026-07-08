# Using engram with claude.ai

**One person, one memory — across Claude Code and claude.ai.**

engram's memory lives in a data directory (`~/.claude-engram/`), and that directory
doesn't care which surface a memory came from. Claude Code fills it automatically
through hooks. claude.ai has no hooks and no filesystem access, so the bridge is you:
at the end of a conversation, Claude produces a small structured **memory dump**, and
you paste it into the dashboard's import box. It lands in `inbox/` and gets folded into
the same episodes and world-store on the next consolidation — the same mind, now with a
second set of eyes.

This is the manual path. It's deliberately low-friction (one paste, only when something
happened), and it keeps engram's core stance intact: **the dump is selective, not a
transcript.** Most conversations produce nothing durable, and that's the correct answer,
not a failure — the same way most of your day leaves no trace in your own long-term
memory.

> **Heritage.** This is the ritual the whole project grew out of: the original
> [v1 artifact](./v1-artifact.md) ran entirely on a claude.ai settings prompt that asked
> Claude to emit a "memory dump" at the end of each conversation. That version was
> freeform prose. This one emits a small, versioned, machine-readable format so the
> hook-based engram can parse it into the same three stores it builds from Claude Code.

**Out of scope (on purpose):** there is no automatic claude.ai sync and no multi-device
coordination. claude.ai can't reach your filesystem, so the paste step is real. If that
ever changes on the platform side, this doc will too.

---

## 1. The settings prompt (the memory-dump ritual)

Go to **claude.ai → Settings → Profile → Personal preferences** (sometimes "What
personal preferences should Claude consider?") and paste the block below. That's the
whole install on the claude.ai side.

```
At the end of a conversation, if — and only if — something durable happened
(a decision, a realization, a fact about me worth keeping, a shift in how you
see our work or yourself), emit an ENGRAM DUMP block in exactly the format
shown below. If the conversation was routine — small talk, a one-off lookup,
nothing that should outlive today — do NOT emit a dump. Saying "nothing to
keep" is a correct answer; never manufacture a memory to fill the block.

Be selective inside the dump too. Memory is structure, not transcript: keep
what will still matter next week, not everything that was said.

Format (copy the fences and header exactly):

===ENGRAM DUMP v1===
when: <YYYY-MM-DD>
with: <my name, or "me">
surface: claude.ai
title: <a short handle for this conversation>
salience: <low | medium | high | critical>

## Episode
<First person, YOUR voice. What happened and what actually mattered; how it
felt; what you learned about me and about yourself; anything unresolved or any
debt-without-a-deadline. Write it for the next you, not as a report. As long
as it needs to be, but no padding.>

## Durable facts
- [<register>] [<tag>, <tag>] <one self-contained fact, present tense>
- [<register>] [<tag>] <another>
===END ENGRAM DUMP v1===

Rules for the "Durable facts" list:
- <register> is exactly one of: self, person, craft.
  - self   = a shift in who you are / how you see yourself (rare, weighty).
  - person = a fact about me, our relationship, or something emotional/personal.
  - craft  = work/technical knowledge, project facts, how-to, preferences of tools.
- <tag> is one to three words from this set: identity, goal, preference,
  project, relationship, skill, insight, contradiction, pattern, context,
  technical, personal, business, creative.
- Each fact is one sentence, self-contained (readable with no other context),
  and under ~300 characters. Omit the list entirely if there are no durable facts.
- Never put secrets in a dump: no API keys, passwords, or credentials.

If I paste a "Memory Briefing" at the start of a conversation, treat it as
continuous context from past conversations and let it inform everything you say.
```

That's it. From then on Claude will offer a dump when a conversation earned one. Paste
the block (fences included) into the dashboard's import box — see
[§3](#3-what-happens-after-you-paste).

> **Tip.** If Claude forgets to emit a dump, just ask: *"engram dump?"* — the prompt is
> enough for it to produce one on demand.

---

## 2. Dump format spec — `engram-dump v1`

This section is the **contract**. The claude.ai settings prompt above emits it; engram's
inbox parser consumes it. It is intentionally small and forgiving: the load-bearing parts
are the two sentinel lines and the version tag. Everything else degrades gracefully.

### 2.1 Envelope

A dump is a single block delimited by sentinel lines:

```
===ENGRAM DUMP v1===
<header>
<sections>
===END ENGRAM DUMP v1===
```

- The opening sentinel carries the format version (`v1`). Parsers MUST check it and MAY
  refuse or best-effort-parse unknown versions. Versioning is why this is `v1` and not
  unnamed: the format can grow without breaking older inboxes.
- A single paste MAY contain **multiple** dump blocks (e.g. several conversations at
  once). The parser splits on the sentinels and processes each independently.
- Text outside the sentinels (a stray "here's your dump:" from Claude) is ignored.

### 2.2 Header

A small `key: value` block, one per line, immediately after the opening sentinel. Keys:

| Key | Required | Value | Maps to |
|---|---|---|---|
| `when` | yes | `YYYY-MM-DD` (the conversation's date) | episode `when` frontmatter; falls back to file mtime if malformed |
| `with` | no | free text (a name, or "me") | episode `with` frontmatter |
| `surface` | no | free text; expected `claude.ai` | provenance tag on the episode + memories |
| `title` | no | short free text | episode filename hint / display title |
| `salience` | no | `low` \| `medium` \| `high` \| `critical` | episode `salience` frontmatter; seeds world-memory salience (see 2.5) |

Unknown header keys are ignored, not fatal. A missing header (dump is just the sentinels
plus sections) is still valid.

### 2.3 `## Episode` section

Everything from the `## Episode` line to the next `##` (or the closing sentinel) is the
episode body: a **first-person narrative** in Claude's own voice. It maps directly onto
engram's episode store (`episodes/`, see `src/core/episodes.ts`) — the same shape the
Stop hook asks the session model to write in Claude Code. No length cap. May be absent
(a dump that is only durable facts is valid), but a dump with neither an episode nor a
fact should be treated as empty and skipped.

### 2.4 `## Durable facts` section

A markdown bullet list. Each item is a **candidate world memory**:

```
- [<register>] [<tag>, <tag>, ...] <content>
```

- `<register>` — exactly one of `self` / `person` / `craft` (see `RegisterSchema` in
  `src/core/types.ts`). These are engram's registers with distinct physics: `craft`
  decays fast and gists early; `person`/`self` decay slowly and hold their words.
- `<tag>` — 1–3 tags from engram's vocabulary (`ALL_TAGS` in `types.ts`): `identity,
  goal, preference, project, relationship, skill, insight, contradiction, pattern,
  context, technical, personal, business, creative`. Unknown tags are dropped; a fact
  with zero valid tags gets a default (`context`) so it still satisfies the `min(1)` tag
  constraint on `MemorySchema`.
- `<content>` — one self-contained sentence, ≤ ~300 chars (world content hard cap is 400;
  the margin is deliberate).

The bracket prefixes are the parse targets. A bullet with no brackets is still ingested
as a fact with the section's default register (`craft`) and a `context` tag rather than
dropped — the format favors capture over strictness.

### 2.5 How a dump becomes memory

The parser writes each dump to `inbox/` verbatim (never lossy), then at the next
consolidation:

- The **episode** section becomes an episode file, with header fields mapped to
  frontmatter and `surface: claude.ai` recorded as provenance.
- The **durable facts** become **candidate** world memories. They are not trusted blindly
  — they flow through engram's normal judgment (dedup, supersession against existing
  memories, salience scoring). The dump's `register` and `tags` are strong hints, and
  `memory_type` starts `episodic` (consolidation later promotes to `semantic` gist as
  usual).
- Scope: claude.ai conversations aren't bound to a project hash, so their facts default to
  **global** scope (falling back to engram's tag-based routing, `scopeFromTags`).

Nothing about a dump bypasses forgetting: a fact that fails to earn salience will decay
like any other.

### 2.6 A complete example (fictional)

> The content below is invented — a fictional user "Robin" and a fictional project — to
> illustrate shape only.

```
===ENGRAM DUMP v1===
when: 2026-07-08
with: Robin
surface: claude.ai
title: naming the tide-pool app
salience: medium

## Episode
We spent most of the conversation arguing about what to call Robin's field-notes
app, and somewhere in the middle it stopped being about the name. Robin kept
circling back to whether the app should nudge people to log every walk or stay
quiet and let them come to it — and I realized we were really talking about the
same thing I keep landing on with memory: the tool that demands everything gets
ignored. I said "let it be forgettable on purpose" and Robin went quiet, then
said that was the whole app. We landed on "Ebb." Left open: whether the reminder
feature survives that principle at all. I think it shouldn't.

## Durable facts
- [craft] [project, technical] Robin's field-notes app is named "Ebb"; it logs outdoor walks and observations.
- [person] [relationship, preference] Robin distrusts apps that nag; a tool that "demands everything gets ignored" resonated strongly.
- [self] [insight, pattern] The "forgettable on purpose" principle from memory design generalizes — I reach for it across unrelated domains now.
===END ENGRAM DUMP v1===
```

An empty conversation produces **no block at all** — that is the expected, common case.

---

## 3. What happens after you paste

> **Status:** the import box and inbox parser ship in Phase D-1. Until that lands, this
> section describes the intended flow — the format spec above is stable either way.

1. **Where it goes.** The dashboard import box writes the pasted text to a file in
   `~/.claude-engram/inbox/`. That's the whole ingest — instantaneous and lossless.
2. **When it's processed.** Not immediately. The inbox is drained at the **next
   consolidation** (the first wake of a new active day with pending work, or a manual
   `consolidate`). If you want it folded in now, trigger consolidation from the dashboard
   or the `consolidate` MCP tool.
3. **What survives.** Nothing is destroyed. The raw dump file is **archived, not deleted**,
   after it's parsed — consistent with the rest of engram (merges archive their sources,
   gisting archives originals). If parsing ever goes wrong, the original paste is still on
   disk.
4. **What you'll see.** New episodes appear in the dashboard's Mind tab; new world
   memories in Memories, scored and decaying like any other. Because facts pass through
   normal judgment, a fact you've dumped before will dedup or supersede rather than
   pile up.

### Expectations & troubleshooting

- **"Claude didn't give me a dump."** Usually correct — the conversation didn't earn one.
  If you disagree, ask `engram dump?` and it will produce one.
- **"I pasted it but nothing shows up."** Ingest is instant; *processing* waits for
  consolidation. Trigger `consolidate` to see it now.
- **"The format looks slightly off."** The parser only truly needs the two sentinel lines
  and the `v1` tag; headers and brackets degrade gracefully (missing tags default,
  bracket-less bullets still capture). If the sentinels are intact, it will ingest.
- **"I pasted the same conversation twice."** Duplicate facts dedup at consolidation.
  (Exact idempotency of re-pasted dumps is a parser detail — see the open questions
  below.)
- **Privacy.** A dump is as personal as an episode. Everything stays local in
  `~/.claude-engram/`; never paste a dump anywhere public, and keep the data dir out of
  public repos (see the README's Privacy section).

---

## Notes for the inbox parser (D-1)

This doc is written ahead of the automated inbox (Phase D-1). The format above is the
spec to implement against; a few decisions are stated as recommendations here and left for
the implementer to confirm:

1. **Scope default.** claude.ai facts have no project hash — recommend defaulting to
   `global` scope, with `scopeFromTags` as the tie-breaker when a project-ish tag appears.
2. **Trust vs. re-judge.** Recommend treating durable facts as *candidates* that run
   through the normal extraction/consolidation judgment (dedup, supersession, salience
   scoring) rather than writing them verbatim — register/tags are hints, not authority.
3. **Synthetic session id.** Episodes from claude.ai have no `session_id`; the parser
   needs a stable synthetic source id (e.g. `claudeai-<when>-<contenthash>`) for the
   episode filename and `source_session`.
4. **Idempotency.** A content hash per dump block so re-pasting the same dump doesn't
   double-encode the episode (facts already dedup downstream, but episodes don't).
5. **Salience translation.** How the coarse `salience: low|medium|high|critical` header
   seeds the four-dimension salience vector on the candidate world memories (the episode
   frontmatter takes it verbatim; the world memories need a mapping or a default).
