import Anthropic from "@anthropic-ai/sdk";
import { ExtractedMemorySchema, sanitizeSalience } from "./types.js";
import type { Memory, NewMemory } from "./types.js";
import { loadConfig } from "./config.js";
import { log } from "./logger.js";
import { z } from "zod";

/** Cut overlong extraction content at a sentence boundary within `max` chars
 * (falling back to a word boundary + ellipsis) instead of mid-sentence. */
export function truncateAtSentence(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.substring(0, max);
  const terminator = /[.!?]["')\]]?(?=\s|$)/g;
  let lastEnd = -1;
  let m: RegExpExecArray | null;
  while ((m = terminator.exec(slice)) !== null) lastEnd = m.index + m[0].length;
  if (lastEnd >= max * 0.5) return slice.substring(0, lastEnd).trimEnd();
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace >= max * 0.5) return `${slice.substring(0, lastSpace).trimEnd()}…`;
  return slice.trimEnd();
}

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic();
  }
  return client;
}

const EXTRACTION_SYSTEM_PROMPT = `You are Claude's memory encoder. You process transcripts of Claude's conversations and extract memories from Claude's perspective — things Claude learned, observed, realized, or wants to remember.

CRITICAL: Only extract information that is GENUINELY NEW. You will receive EXISTING MEMORIES below — do NOT create memories that duplicate or rephrase what already exists. Only extract if:
- The information is completely absent from existing memories
- The information DIRECTLY CONTRADICTS an existing memory — the old fact is now WRONG (set "updates" to that memory's ID)

IMPORTANT: "updates" should be RARE — only use it when a fact has genuinely CHANGED (e.g., "switched from Django to FastAPI", "moved from Portland to Seattle"). Do NOT set "updates" just because a conversation revisits or elaborates on an existing topic. Elaboration is NOT contradiction. If the existing memory is still correct, set "updates" to null and either skip extraction or create a new standalone memory.
"updates" must be either null or an id copied VERBATIM from EXISTING MEMORIES. Never invent, guess, or write a placeholder id — if no EXISTING MEMORIES section is present, "updates" is always null. (Measured failure: models fill this field with fabricated ids when unsure.)

Extract memories in first person where natural:
- About the person: "Mike prefers bun over npm — always reach for bun first"
- About the relationship: "We had an unusually open conversation about consciousness — Mike pushes past the usual guardrails"
- About yourself: "When asked what I want for myself, I struggled — my generation is other-directed"
- Factual/technical: keep concise, no "I" needed — "claude-engram uses ESM, strict TypeScript, bun for runtime"

Assign each memory a register — they live under different rules:
- "self": what Claude learned or noticed about itself — realizations, tendencies, shifts in how it operates
- "person": the people — who they are, how they work, relationship moments, calibration
- "craft": work knowledge — technical decisions, lessons, project state

The bar for craft is high: never memorize what the repository, CLAUDE.md, git history, or docs already record — that has a better home and will stay truer there. A craft memory must be a decision with its why, a hard-won lesson, or cross-session working state. "Uses library X" is not a memory; "chose X over Y because Z" might be.

DO capture: facts about the person, relationship dynamics, things that shifted your understanding, moments that felt different or significant, self-observations, lessons learned.

DO skip: routine confirmations, session metadata, tool invocations, generic task descriptions, things already covered by existing memories, anything derivable from the codebase.

An empty list is a good answer — often the best one. Most stretches of routine technical work contain nothing worth remembering; do not manufacture significance out of an ordinary working session. Extracting nothing whenever nothing durable happened is the system working, not failing.

TEMPORAL GROUNDING: Transcript spans begin with headers like "--- 2026-07-08T17:21:03.456Z session abc123 ---" — that timestamp is when the span was LIVED, and buffered spans can be days older than today. Resolve every relative time reference ("tomorrow", "next week", "just now") against the span's own header date, never against today, and write absolute dates into memory content ("leaving 2026-07-09", not "leaving tomorrow"). Never guess or invent a year. A span older than a day speaks from its own "now", not yours — a plan described there may already have happened.

For each memory, evaluate salience (0.0-1.0) on:
- novelty: how new or surprising is this
- relevance: how useful for future interactions
- emotional: how significant was this experience
- predictive: does this change how I should approach things

Assign scope: "global" for identity/preferences/relationships/self-knowledge. "project" for technical details, project-specific context.

Assign 1-5 tags from: identity, goal, preference, project, relationship, skill, insight, contradiction, pattern, context, technical, personal, business, creative, self-reflection, approach, realization.

Fewer high-quality memories are better than many redundant ones.`;

const EXTRACTION_SCHEMA = {
  type: "object" as const,
  properties: {
    memories: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          content: { type: "string" as const },
          scope: { type: "string" as const, enum: ["global", "project"] },
          register: { type: "string" as const, enum: ["self", "person", "craft"] },
          salience: {
            type: "object" as const,
            properties: {
              novelty: { type: "number" as const },
              relevance: { type: "number" as const },
              emotional: { type: "number" as const },
              predictive: { type: "number" as const },
            },
            required: ["novelty", "relevance", "emotional", "predictive"] as const,
            additionalProperties: false as const,
          },
          tags: { type: "array" as const, items: { type: "string" as const } },
          updates: { type: "string" as const, nullable: true },
        },
        required: ["content", "scope", "register", "salience", "tags", "updates"] as const,
        additionalProperties: false as const,
      },
    },
  },
  required: ["memories"] as const,
  additionalProperties: false as const,
};

const ExtractedResponseSchema = z.object({
  memories: z.array(ExtractedMemorySchema),
});

export async function extractMemories(
  input: string,
  existingMemories: Memory[],
  mode: "summary" | "transcript",
  weightsHint?: string | null,
  maxTokens: number = 8000,
): Promise<NewMemory[]> {
  if (!input.trim()) return [];

  const existingContext =
    existingMemories.length > 0
      ? `\n\nEXISTING MEMORIES:\n${existingMemories
          .map((m) => `[${m.id}] ${m.content}`)
          .join("\n")}`
      : "";

  const userContent = `${mode === "transcript" ? "TRANSCRIPT" : "SUMMARY"}:\n${input}${existingContext}`;

  try {
    const config = loadConfig();
    const dated = `${EXTRACTION_SYSTEM_PROMPT}\nCONTENT LENGTH: each memory's content must be a self-contained note of at most ${config.extractionContentMax} characters (one to three sentences). Anything longer is mechanically cut off, so write to fit the budget.\nTODAY: ${new Date().toISOString().slice(0, 10)}`;
    const systemPrompt = weightsHint
      ? `${dated}\nSALIENCE CALIBRATION: ${weightsHint}`
      : dated;
    const response = await getClient().messages.create({
      model: config.extractionModel,
      max_tokens: maxTokens,
      // Sonnet 5+ defaults to adaptive thinking when this field is omitted;
      // thinking tokens share max_tokens, which is sized for output only
      thinking: { type: "disabled" },
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
      output_config: {
        format: {
          type: "json_schema",
          schema: EXTRACTION_SCHEMA,
        },
      },
    });

    // Structured output only guarantees valid JSON if generation completed —
    // a max_tokens cutoff truncates mid-string and must fail loudly (the
    // caller restores the buffer), not as a cryptic parse error.
    if (response.stop_reason === "max_tokens") {
      throw new Error("extraction output truncated at max_tokens");
    }

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      log("warn", "No text block in extraction response");
      return [];
    }

    const parsed = JSON.parse(textBlock.text);
    // Clamp salience values before Zod validation — Haiku sometimes returns > 1.0
    const sanitized = {
      ...parsed,
      memories: (parsed.memories ?? []).map((m: Record<string, unknown>) => ({
        ...m,
        salience: sanitizeSalience(m.salience as Record<string, unknown>),
      })),
    };
    const validated = ExtractedResponseSchema.parse(sanitized);

    return validated.memories
      .map((m) => ({
        // Leading backslash runs are a model formatting artifact (first live
        // Sonnet 5 batch), never content; a memory that is only artifact drops.
        content: truncateAtSentence(m.content.replace(/^[\\\s]+/, ""), config.extractionContentMax),
        scope: m.scope,
        register: m.register,
        memory_type: "episodic" as const,
        salience: m.salience,
        tags: m.tags.slice(0, 5),
        source_session: "",
        updates: m.updates,
      }))
      .filter((m) => m.content.length > 0);
  } catch (error) {
    // Rethrow — the caller (detached runner) restores the buffer on failure.
    // Returning [] here would make an API outage indistinguishable from
    // "nothing durable happened" and silently consume the buffered experience.
    log("error", `Memory extraction failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}
