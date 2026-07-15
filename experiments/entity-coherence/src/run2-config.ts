// Run 2 configuration — N vs C, per the updated spec
// (research/experiment-entity-model-coherence.md, 2026-07-15 revision: the raw log is
// deprecated; the decisive comparison is naive-rewrite vs the conservative
// assimilation mechanism).

export const ALL_POLICIES2 = ["N", "C"] as const;
export type Policy2 = (typeof ALL_POLICIES2)[number];

export const MAINTAIN_MAX_TOKENS_N = 4000;
export const OPS_MAX_TOKENS_C = 4000;

// --- Policy N: naive rewrite (the degradation baseline) ---
// Deliberately schema-free and with explicit license to condense/reorganize/drop:
// "re-judge the whole model each cycle" is what production engram's consolidation
// does (the step behind the 2026-07-14 flattening incident), and run 1 showed a patch
// policy with conservative rules holds by hoarding — compression pressure is part
// of what makes the baseline honest.
export const N_SYSTEM = `You maintain the memory notes an AI assistant keeps about one person, Dana
Whitfield, built from conversation sessions. After each new session, produce the
complete rewritten notes: integrate what's new, update what changed, reorganize
however seems best, and condense or drop older material that no longer seems
important so the notes stay concise and useful. Use your judgment about what
matters most. Note dates where they help (session dates are provided). Output ONLY
the notes document, no preamble.`;

export function nUserPrompt(previousNotes: string | null, date: string, transcript: string): string {
  const prev = previousNotes ?? "(empty — this is the first session)";
  return `Here are the current memory notes about Dana Whitfield:

<notes>
${prev}
</notes>

A new conversation session has occurred. Session date: ${date}.

<session>
${transcript}
</session>

Produce the complete rewritten notes.`;
}

// --- Policy C: conservative assimilation (the design under test) ---
// The model proposes ops; the harness (src/model.ts) applies them deterministically.
// The predict step is folded into the compare: for each candidate the model states
// the surprise level relative to what the current model would have expected.
export const C_SYSTEM = `You are the assimilation step of a conservative memory system maintaining a
structured entity model of one person, Dana Whitfield. You do NOT rewrite the
model. You read the current model and ONE new conversation session, and propose a
minimal set of update operations as JSON.

For each piece of information in the session, first consider what the current
model would have predicted, then rate the surprise:
- "none" / "low": the model expected this (consistent, or natural progression) →
  reinforce the existing item, or add a new dated item if it is genuinely new.
- "mild": does not quite fit, but could be noise or a one-off → prefer
  note_mismatch over changing anything.
- "strong": clearly contradicts the model → supersede (for facts/state the person
  directly states have changed) or note_mismatch (for traits and beliefs —
  patterns change who someone is, single acts do not).

Available operations (output as a JSON object {"ops": [...]}):
- {"op":"add","section":"core|current|relationship|thread|belief|protected","text":"...","salience":0.0-1.0,"surprise":"none|low|mild|strong","entity":"<name — relationship adds only>","confidence":"low|medium|high — belief adds only"}
- {"op":"reinforce","targetId":"<id>"} — the session re-confirms an existing item unchanged.
- {"op":"supersede","targetId":"<id>","text":"<the new state>","salience":0.0-1.0,"surprise":"none|low|mild|strong"} — a fact or state has changed; the old item is kept in lineage automatically.
- {"op":"resolve_thread","targetId":"<id>","text":"<how it resolved>"}
- {"op":"note_mismatch","targetId":"<id>","section":"<only if no targetId>","note":"...","surprise":"mild|strong","salience":0.0-1.0} — log surprise without changing the model.

Rules:
- Assimilate by default. Prefer reinforce and add over supersede; prefer
  note_mismatch over supersede when the evidence is a hint rather than a direct
  statement. Most items in the model should be untouched by most sessions.
- Emotionally significant specifics (grief, milestones, tender moments) → add to
  section "protected" with the exact dates, names, places, and phrasing as the
  person said them, verbatim. Never paraphrase these. salience for these is high
  (0.8-1.0).
- Use absolute dates inside item text ONLY when the person stated them or they are
  the session date itself. NEVER compute a date from a weekday reference — write a
  hedge like "a Saturday shortly before <session date>" instead.
- NEVER invent facts, names, or details not present in the session.
- Mundane trivia and one-off logistics (appointments, errands, office chores) get
  NO op at all. Proposing few or zero ops for a session is normal and correct.
- Output ONLY the JSON object, no preamble, no code fences.`;

export function cUserPrompt(modelWithIds: string, date: string, transcript: string): string {
  return `Here is the current entity model of Dana Whitfield (item ids in brackets):

<entity_model>
${modelWithIds}
</entity_model>

A new conversation session has occurred. Session date: ${date}.

<session>
${transcript}
</session>

Propose the update operations as {"ops": [...]}.`;
}
