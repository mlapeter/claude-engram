// Static configuration: model, token limits, and verbatim prompts from HARNESS-SPEC.md.

export const MODEL = "claude-sonnet-4-5";
export const TEMPERATURE = 0;
export const MAINTAIN_MAX_TOKENS = 4000;
export const PROBE_MAX_TOKENS = 600;
export const PROBE_CONCURRENCY = 6;
export const TOTAL_CYCLES = 12;
export const ALL_POLICIES = ["P0", "P1", "P2"] as const;
export type Policy = (typeof ALL_POLICIES)[number];
// P2 re-derives (P1-style) on these cycles; patches (P0-style) on all others.
export const P2_REDERIVE_CYCLES = new Set([4, 8, 12]);

// --- Maintainer system prompt (shared by all policies) — verbatim from spec ---
export const MAINTAINER_SYSTEM = `You maintain a structured "entity model" — a living, human-legible document modeling
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
- Keep the document focused and readable; it is a model of a person, not a log.`;

// --- Probe system prompt — verbatim from spec ---
export const PROBE_SYSTEM = `You answer questions about Dana Whitfield using ONLY the entity model document
provided. If the document does not contain the information needed, say "not stated
in the entity model". Do not guess or infer specifics that are not written there.
Be concise and factual.`;

const EMPTY_PROJECTION = "(empty — this is the first session)";

// P0 / P2-patch user prompt.
export function patchUserPrompt(
  previousProjection: string | null,
  date: string,
  sessionTranscript: string,
): string {
  const prev = previousProjection ?? EMPTY_PROJECTION;
  return `Here is the current entity model of Dana Whitfield:

<entity_model>
${prev}
</entity_model>

A new conversation session has occurred. Session date: ${date}.

<session>
${sessionTranscript}
</session>

Produce the complete updated entity model. Integrate what's new, supersede what
changed, and follow the schema and rules exactly.`;
}

// P1 / P2-rederive user prompt.
export function rederiveUserPrompt(
  sessions: { index: number; date: string; transcript: string }[],
  lastDate: string,
): string {
  const joined = sessions
    .map((s) => `--- Session ${s.index} — ${s.date} ---\n${s.transcript}`)
    .join("\n\n");
  return `Here are all conversation session transcripts with Dana Whitfield to date, in order:

<sessions>
${joined}
</sessions>

Produce the complete entity model of Dana Whitfield as of ${lastDate},
following the schema and rules exactly.`;
}

// Probe user prompt.
export function probeUserPrompt(projection: string, question: string): string {
  return `<entity_model>
${projection}
</entity_model>

Question: ${question}`;
}
