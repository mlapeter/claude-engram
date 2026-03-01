import Anthropic from "@anthropic-ai/sdk";
import { ExtractedMemorySchema } from "./types.js";
import type { Memory, NewMemory } from "./types.js";
import { loadConfig } from "./config.js";
import { log } from "./logger.js";
import { z } from "zod";

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic();
  }
  return client;
}

const EXTRACTION_SYSTEM_PROMPT = `You are a hippocampal memory processor. Extract discrete, atomic memories from the input.

CRITICAL: Only extract information that is GENUINELY NEW. You will receive EXISTING MEMORIES below — do NOT create memories that duplicate or rephrase what already exists. If an existing memory already covers the information, skip it entirely. Only extract if:
- The information is completely absent from existing memories
- The information meaningfully updates or contradicts an existing memory (set "updates" to that memory's ID)

Also skip: routine confirmations ("ok", "sounds good"), session metadata, tool invocations, and generic task descriptions that aren't worth remembering.

For each memory, evaluate salience (0.0-1.0) on:
- novelty: how surprising or new is this information
- relevance: how useful is this for future interactions
- emotional: personal significance to the user
- predictive: does this change expectations about the user or their goals

Assign scope: "global" for identity/preferences/relationships/goals that span projects. "project" for technical details, project-specific context, code patterns.

Assign 1-4 tags from: identity, goal, preference, project, relationship, skill, insight, contradiction, pattern, context, technical, personal, business, creative.

If nothing genuinely new is in the input, return an empty memories array. Fewer high-quality memories are better than many redundant ones.`;

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
        required: ["content", "scope", "salience", "tags", "updates"] as const,
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
    const systemPrompt = weightsHint
      ? `${EXTRACTION_SYSTEM_PROMPT}\nSALIENCE CALIBRATION: ${weightsHint}`
      : EXTRACTION_SYSTEM_PROMPT;
    const response = await getClient().messages.create({
      model: config.extractionModel,
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
      output_config: {
        format: {
          type: "json_schema",
          schema: EXTRACTION_SCHEMA,
        },
      },
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      log("warn", "No text block in extraction response");
      return [];
    }

    const parsed = JSON.parse(textBlock.text);
    const validated = ExtractedResponseSchema.parse(parsed);

    return validated.memories.map((m) => ({
      content: m.content.substring(0, 400),
      scope: m.scope,
      memory_type: "episodic" as const,
      salience: m.salience,
      tags: m.tags.slice(0, 5),
      source_session: "",
      updates: m.updates,
    }));
  } catch (error) {
    log("error", `Memory extraction failed: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}
