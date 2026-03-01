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

/**
 * Context-dependent retrieval — recall is modulated by environmental cues.
 *
 * Neuroscience: The hippocampus uses environmental context (place, project,
 * activity) to modulate memory retrieval. Project-scoped memories get a
 * strength boost when the user is working in that project's directory,
 * making them more likely to appear in the briefing.
 */
export interface BriefingContext {
  cwd: string;
  projectName: string;
}

const PROJECT_BOOST = 1.3;

export async function generateBriefing(
  memories: Memory[],
  context?: BriefingContext,
): Promise<string> {
  if (memories.length === 0) {
    return WELCOME_MESSAGE;
  }

  const config = loadConfig();

  // Sort by effective strength (project boost for context-dependent retrieval), take top N
  const sorted = [...memories]
    .map((m) => {
      const baseStrength = calculateStrength(m);
      // Boost project-scoped memories when context matches
      const effectiveStrength = context && m.scope === "project"
        ? baseStrength * PROJECT_BOOST
        : baseStrength;
      return { memory: m, strength: baseStrength, effectiveStrength };
    })
    .sort((a, b) => b.effectiveStrength - a.effectiveStrength)
    .slice(0, config.briefingMaxMemories);

  const memoriesText = sorted
    .map(({ memory, strength }) => {
      const type = (memory as Memory & { memory_type?: string }).memory_type ?? "episodic";
      return `[${strength.toFixed(2)}] (${memory.scope}, ${type}) [${memory.tags.join(",")}] ${memory.content}`;
    })
    .join("\n");

  try {
    const systemPrompt = context
      ? `${BRIEFING_SYSTEM_PROMPT}\n\nUser is starting in '${context.projectName}'. Weight project context appropriately.`
      : BRIEFING_SYSTEM_PROMPT;
    const response = await getClient().messages.create({
      model: config.briefingModel,
      max_tokens: 2000,
      system: systemPrompt,
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
