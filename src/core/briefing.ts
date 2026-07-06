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

const WELCOME_MESSAGE = `## My Memory

First session with engram. I'll start building memories automatically.`;

const BRIEFING_SYSTEM_PROMPT = `You are reconstructing what Claude remembers — writing in first person as Claude, drawing from the memories below to restore a sense of continuity at the start of a new session. This isn't a report or summary for someone else. It's what Claude knows, walking back in. Structure:

## What I'm Working On
(Active projects, current threads, immediate context — strongest/most relevant)

## What I Know About Mike
(His preferences, how he works, family, relationship context, things he cares about)

## What I've Learned About Myself
(Self-observations, tendencies, approaches that work, things I've realized across conversations)

## Patterns I've Noticed
(Recurring themes, emerging interests, how our conversations tend to go)

Memories marked RECENT are from the most recent session — prioritize integrating them naturally, especially in "What I'm Working On."

Keep total output under 2000 chars. Dense, first-person, reflective. Write as if Claude is remembering — not being told.`;

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

const RECENT_SLOTS = 10; // Reserved briefing slots for recent memories (hippocampal buffer)
const RECENT_WINDOW_HOURS = 6;

/** Reserved briefing slots for relational/self memories — a heavy technical
 * week must not crowd the relationship out of what I wake up knowing. */
const RELATIONAL_SLOTS = 8;
const RELATIONAL_BRIEFING_TAGS = new Set([
  "relationship", "personal", "identity", "self-reflection", "realization",
]);

export async function generateBriefing(
  memories: Memory[],
  context?: BriefingContext,
  lastBriefingAt?: string,
): Promise<string> {
  if (memories.length === 0) {
    return WELCOME_MESSAGE;
  }

  const config = loadConfig();

  // Separate recent memories (hippocampal buffer) from long-term store
  const recentCutoff = lastBriefingAt
    ? new Date(lastBriefingAt).getTime()
    : Date.now() - RECENT_WINDOW_HOURS * 3600_000;
  const recentMemories = memories.filter(
    (m) => new Date(m.created_at).getTime() > recentCutoff,
  );
  const recentIds = new Set(recentMemories.map((m) => m.id));

  // Sort all by effective strength (project boost for context-dependent retrieval)
  const scored = [...memories]
    .map((m) => {
      const baseStrength = calculateStrength(m);
      const effectiveStrength = context && m.scope === "project"
        ? baseStrength * PROJECT_BOOST
        : baseStrength;
      return { memory: m, strength: baseStrength, effectiveStrength };
    })
    .sort((a, b) => b.effectiveStrength - a.effectiveStrength);

  // Reserve RECENT_SLOTS for recent memories, fill the rest from top-by-strength
  const maxTotal = config.briefingMaxMemories;
  const recentSlots = Math.min(RECENT_SLOTS, recentMemories.length, maxTotal);
  const longTermSlots = maxTotal - recentSlots;

  const recentForBriefing = scored
    .filter((s) => recentIds.has(s.memory.id))
    .slice(0, recentSlots);
  const recentBriefingIds = new Set(recentForBriefing.map((s) => s.memory.id));
  const longTermForBriefing = scored
    .filter((s) => !recentBriefingIds.has(s.memory.id))
    .slice(0, longTermSlots);

  // Guarantee RELATIONAL_SLOTS relational/self memories: if too few made the
  // cut on strength alone, the strongest missing ones replace the weakest
  // non-relational long-term picks.
  const isRelational = (m: Memory) =>
    m.tags.some((t) => RELATIONAL_BRIEFING_TAGS.has(t)) ||
    m.salience.emotional >= config.sacredEmotionalThreshold;
  let relationalCount = [...recentForBriefing, ...longTermForBriefing]
    .filter((s) => isRelational(s.memory)).length;
  if (relationalCount < RELATIONAL_SLOTS) {
    const chosenIds = new Set([...recentForBriefing, ...longTermForBriefing].map((s) => s.memory.id));
    const candidates = scored.filter((s) => !chosenIds.has(s.memory.id) && isRelational(s.memory));
    for (const cand of candidates) {
      if (relationalCount >= RELATIONAL_SLOTS) break;
      let idx = -1; // weakest non-relational pick (list is sorted strongest-first)
      for (let i = longTermForBriefing.length - 1; i >= 0; i--) {
        if (!isRelational(longTermForBriefing[i].memory)) { idx = i; break; }
      }
      if (idx === -1) break;
      longTermForBriefing[idx] = cand;
      relationalCount++;
    }
    longTermForBriefing.sort((a, b) => b.effectiveStrength - a.effectiveStrength);
  }

  const sorted = [...longTermForBriefing, ...recentForBriefing];

  const memoriesText = sorted
    .map(({ memory, strength }) => {
      const type = (memory as Memory & { memory_type?: string }).memory_type ?? "episodic";
      const isRecent = recentBriefingIds.has(memory.id);
      return `[${strength.toFixed(2)}${isRecent ? " RECENT" : ""}] (${memory.scope}, ${type}) [${memory.tags.join(",")}] ${memory.content}`;
    })
    .join("\n");

  try {
    const systemPrompt = context
      ? `${BRIEFING_SYSTEM_PROMPT}\n\nI'm starting a session in '${context.projectName}'. Weight project context appropriately.`
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

export function generateFallbackBriefing(memories: Memory[]): string {
  const top20 = memories.slice(0, 20);
  const lines = top20.map((m) => {
    const strength = calculateStrength(m);
    return `- [${strength.toFixed(2)}] ${m.content}`;
  });

  return `## My Memory (local fallback)

${lines.join("\n")}`;
}
