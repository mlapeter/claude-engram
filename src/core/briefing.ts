import Anthropic from "@anthropic-ai/sdk";
import type { Memory } from "./types.js";
import { loadConfig } from "./config.js";
import { calculateStrength } from "./strength.js";
import { log } from "./logger.js";

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic();
  }
  return client;
}

const WELCOME_MESSAGE = `## Memory Context

First session with engram. Memories will be captured automatically.`;

const BRIEFING_SYSTEM_PROMPT = `Generate a concise context briefing from these memories for use as
persistent context at the start of a Claude Code session. Structure:

## Active Context
(Current goals, projects, immediate concerns — strongest/most relevant)

## Core Knowledge
(Established facts — identity, preferences, relationships, constraints)

## Recent Patterns
(Behavioral patterns, recurring themes, emerging interests)

## Fading Context
(Potentially relevant but losing salience — brief mentions only)

Keep total output under 2000 chars. Dense, informative, system-prompt style.`;

export async function generateBriefing(memories: Memory[]): Promise<string> {
  if (memories.length === 0) {
    return WELCOME_MESSAGE;
  }

  const config = loadConfig();

  // Sort by strength, take top N
  const sorted = [...memories]
    .map((m) => ({ memory: m, strength: calculateStrength(m) }))
    .sort((a, b) => b.strength - a.strength)
    .slice(0, config.briefingMaxMemories);

  const memoriesText = sorted
    .map(({ memory, strength }) =>
      `[${strength.toFixed(2)}] (${memory.scope}) [${memory.tags.join(",")}] ${memory.content}`,
    )
    .join("\n");

  try {
    const response = await getClient().messages.create({
      model: config.briefingModel,
      max_tokens: 2000,
      system: BRIEFING_SYSTEM_PROMPT,
      messages: [{ role: "user", content: memoriesText }],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (textBlock && textBlock.type === "text") {
      return textBlock.text;
    }

    log("warn", "No text block in briefing response, using fallback");
    return generateFallbackBriefing(sorted.map((s) => s.memory));
  } catch (error) {
    log("error", `Briefing generation failed: ${error instanceof Error ? error.message : String(error)}`);
    return generateFallbackBriefing(sorted.map((s) => s.memory));
  }
}

function generateFallbackBriefing(memories: Memory[]): string {
  const top20 = memories.slice(0, 20);
  const lines = top20.map((m) => {
    const strength = calculateStrength(m);
    return `- [${strength.toFixed(2)}] ${m.content}`;
  });

  return `## Memory Context (local fallback)

${lines.join("\n")}`;
}
