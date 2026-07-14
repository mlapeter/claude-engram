import Anthropic from "@anthropic-ai/sdk";
import type { Memory } from "./types.js";
import { registerOf } from "./types.js";
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

Each memory is marked with its register: (craft) feeds "What I'm Working On"; (person) feeds "What I Know About Mike"; (self) feeds "What I've Learned About Myself". Memories marked RECENT are from the most recent session — prioritize integrating them naturally, especially in "What I'm Working On."

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

/** Long-term briefing slots are budgeted per register — the briefing's
 * sections map to registers (working-on ← craft, about-Mike ← person,
 * about-myself ← self), so a heavy technical week can never crowd the
 * relationship out of what I wake up knowing. Unfilled budgets spill over. */
const REGISTER_BUDGET_SHARE = { craft: 0.5, person: 0.25, self: 0.25 } as const;

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

  // Compose long-term slots by register budget (strongest-first within each),
  // then spill unfilled budget to overall strength order
  const remaining = scored.filter((s) => !recentBriefingIds.has(s.memory.id));
  const budget = {
    craft: Math.round(longTermSlots * REGISTER_BUDGET_SHARE.craft),
    person: Math.round(longTermSlots * REGISTER_BUDGET_SHARE.person),
    self: Math.round(longTermSlots * REGISTER_BUDGET_SHARE.self),
  };
  const longTermForBriefing: typeof scored = [];
  const taken = new Set<string>();
  for (const reg of ["self", "person", "craft"] as const) {
    for (const s of remaining) {
      if (budget[reg] <= 0) break;
      if (taken.has(s.memory.id) || registerOf(s.memory) !== reg) continue;
      longTermForBriefing.push(s);
      taken.add(s.memory.id);
      budget[reg]--;
    }
  }
  for (const s of remaining) {
    if (longTermForBriefing.length >= longTermSlots) break;
    if (!taken.has(s.memory.id)) { longTermForBriefing.push(s); taken.add(s.memory.id); }
  }
  longTermForBriefing.sort((a, b) => b.effectiveStrength - a.effectiveStrength);

  const sorted = [...longTermForBriefing, ...recentForBriefing];

  const memoriesText = sorted
    .map(({ memory, strength }) => {
      const type = (memory as Memory & { memory_type?: string }).memory_type ?? "episodic";
      const isRecent = recentBriefingIds.has(memory.id);
      return `[${strength.toFixed(2)}${isRecent ? " RECENT" : ""}] (${memory.scope}, ${registerOf(memory)}, ${type}) [${memory.tags.join(",")}] ${memory.content}`;
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

/**
 * "Right now" lane: recent person/self memories injected verbatim at session
 * start, assembled by code — no model judgment between the fact and the
 * briefing. Present-state facts ("Mike is on the river until Sunday") are
 * low-strength by design — transient, little long-horizon value — so they
 * lose every synthesis and ranking competition against durable traits; but
 * they are exactly what a friend wakes up knowing. The window runs on
 * CALENDAR days, not active days: decay runs on lived time, present-state
 * relevance runs on world time.
 */
export function presentStateLane(memories: Memory[], now: Date = new Date()): string {
  const config = loadConfig();
  const windowMs = config.presentStateWindowDays * 24 * 3600_000;

  const candidates = memories
    .filter((m) => registerOf(m) !== "craft")
    .filter((m) => {
      const age = now.getTime() - new Date(m.created_at).getTime();
      return age >= 0 && age < windowMs;
    })
    .map((m) => {
      const s = m.salience;
      const avg =
        ((Number(s?.novelty) || 0) + (Number(s?.relevance) || 0) +
         (Number(s?.emotional) || 0) + (Number(s?.predictive) || 0)) / 4;
      const ageDays = (now.getTime() - new Date(m.created_at).getTime()) / 86_400_000;
      // Salience-ranked with gentle recency decay; the byte budget does the
      // gating — no admission threshold to fall off a cliff over
      return { m, score: avg * Math.exp(-ageDays / 7) };
    })
    .sort((a, b) => b.score - a.score);

  // One intense session must not monopolize the lane (a session about the
  // memory system mints a burst of high-salience person memories); cap
  // entries per source session, and truncate entries so the budget holds
  // several distinct facts rather than three long ones
  const PER_SESSION_CAP = 2;
  const ENTRY_MAX_CHARS = 300;
  const perSession = new Map<string, number>();
  const lines: string[] = [];
  let bytes = 0;
  for (const { m } of candidates) {
    const seen = perSession.get(m.source_session) ?? 0;
    if (seen >= PER_SESSION_CAP) continue;
    const content = m.content.length > ENTRY_MAX_CHARS ? `${m.content.slice(0, ENTRY_MAX_CHARS)}…` : m.content;
    const line = `- (${m.created_at.slice(0, 10)}) ${content}`;
    if (bytes + line.length > config.presentStateMaxBytes) break;
    perSession.set(m.source_session, seen + 1);
    lines.push(line);
    bytes += line.length + 1;
  }
  if (lines.length === 0) return "";

  return `## Right now

Recent life context, carried verbatim from the last ${config.presentStateWindowDays} days:

${lines.join("\n")}

`;
}
