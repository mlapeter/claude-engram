/**
 * The inbox parser — claude.ai memory dumps become engram memory.
 *
 * claude.ai has no hooks and no filesystem access, so the bridge is a manual
 * paste: at the end of a conversation Claude emits a small structured "engram
 * dump", the dashboard writes it verbatim to `inbox/`, and this parser turns it
 * into episodes + candidate world memories at the next consolidation.
 *
 * This module is PURE (no fs, no store, no API) so the whole parse surface is
 * unit-testable under vitest — the drain that consumes it lives in
 * consolidation.ts. The format is the `engram-dump v1` contract in
 * docs/claude-ai-companion.md §2: two sentinel lines and a version tag are the
 * only load-bearing parts; everything else degrades gracefully (unknown header
 * keys ignored, bracket-less bullets captured with defaults, text outside the
 * sentinels ignored, multiple blocks per paste).
 */

import { createHash } from "node:crypto";
import type { Register, Salience } from "./types.js";
import {
  ALL_TAGS,
  PROJECT_TAGS,
  RegisterSchema,
  sanitizeSalience,
  scopeFromTags,
} from "./types.js";

// --- Sentinels ---
// The opening sentinel carries the version; the closing one is matched leniently
// (version optional) so a stray "v1" mismatch on the END line never strands a block.
const OPEN_SENTINEL = /^===ENGRAM DUMP (v\d+)===[ \t]*$/;
const CLOSE_SENTINEL = /^===END ENGRAM DUMP.*===[ \t]*$/;

const SECTION_HEADING = /^##\s+(.*?)\s*$/;
const HEADER_PAIR = /^([A-Za-z][\w-]*)\s*:\s?(.*)$/;
const BULLET = /^\s*[-*]\s+(.*)$/;
const LEADING_BRACKET = /^\[([^\]]*)\]\s*/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type SalienceLevel = "low" | "medium" | "high" | "critical";
const SALIENCE_LEVELS: readonly SalienceLevel[] = ["low", "medium", "high", "critical"];

export interface DumpFact {
  register: Register;
  tags: string[];
  content: string;
}

export interface ParsedDump {
  /** Version from the opening sentinel (e.g. "v1"). */
  version: string;
  /** Valid YYYY-MM-DD only; undefined when missing or malformed (drain falls back to mtime). */
  when?: string;
  with?: string;
  surface?: string;
  title?: string;
  /** Coarse header level, undefined when missing/unrecognized (drain defaults to medium). */
  salience?: SalienceLevel;
  /** First-person narrative body, trimmed; undefined when absent or blank. */
  episode?: string;
  /** Candidate world memories — register/tags are hints, re-judged downstream. */
  facts: DumpFact[];
  /** Stable content hash for episode idempotency (see dumpHash). */
  hash: string;
  /** True when the block had an opening sentinel but no closing one (captured to EOF/next block). */
  unterminated: boolean;
  /** Every header key as written, for provenance/debugging (includes unknown keys). */
  rawHeader: Record<string, string>;
}

/** A dump with neither an episode nor a fact carries nothing — the drain skips it. */
export function isEmptyDump(d: ParsedDump): boolean {
  return !d.episode && d.facts.length === 0;
}

/**
 * Salience translation — the coarse header level seeds the four-dimension
 * salience vector on candidate world memories (episode frontmatter keeps the
 * level verbatim). The level drives forward-looking dimensions (relevance +
 * predictive) most, novelty modestly, and emotional LEAST: emotional ≥ 0.75 is
 * engram's sacred-verbatim trigger (exempt from gisting, merge, interference),
 * and a coarse dropdown must never mint that tier — it is reserved for
 * genuinely tender, human-lived memory. Emotional is nudged up for person/self
 * facts (more affective by kind) but hard-capped at 0.7, always below sacred.
 */
const SALIENCE_BY_LEVEL: Record<SalienceLevel, Salience> = {
  low: { novelty: 0.2, relevance: 0.3, emotional: 0.1, predictive: 0.2 },
  medium: { novelty: 0.3, relevance: 0.5, emotional: 0.2, predictive: 0.4 },
  high: { novelty: 0.4, relevance: 0.7, emotional: 0.35, predictive: 0.6 },
  critical: { novelty: 0.5, relevance: 0.9, emotional: 0.45, predictive: 0.8 },
};
const SACRED_CAP = 0.7; // stay strictly below sacredEmotionalThreshold (0.75)

export function salienceForFact(level: SalienceLevel | undefined, register: Register): Salience {
  const base = SALIENCE_BY_LEVEL[level ?? "medium"];
  const bump = register === "person" || register === "self" ? 0.15 : 0;
  return sanitizeSalience({ ...base, emotional: Math.min(base.emotional + bump, SACRED_CAP) });
}

/**
 * Scope routing for a claude.ai fact. Recommendation D-1 #1: default to GLOBAL
 * (claude.ai conversations have no project home), and only let scopeFromTags
 * break the tie when a project-ish tag (project/technical/context) is present.
 *
 * CAVEAT (flagged): a fact routed to "project" lands in whichever project store
 * the consolidation run happens to belong to — claude.ai has no real project, so
 * this is arbitrary. This is the documented tie-break; global-leaning is
 * deliberate to minimize cross-project contamination.
 */
export function inboxFactScope(tags: string[]): "global" | "project" {
  const projectish = tags.some((t) => (PROJECT_TAGS as readonly string[]).includes(t));
  return projectish ? scopeFromTags(tags) : "global";
}

/**
 * Stable idempotency hash over a dump's meaningful content — surrounding
 * whitespace and cosmetic header differences don't change it, so re-pasting the
 * same dump maps to the same synthetic session id / episode file and doesn't
 * double-encode. Facts already dedup downstream; episodes need this.
 */
export function dumpHash(d: Pick<ParsedDump, "when" | "title" | "episode" | "facts">): string {
  const canonical = [
    d.when ?? "",
    (d.title ?? "").trim(),
    (d.episode ?? "").trim(),
    ...d.facts.map((f) => `${f.register}|${f.tags.join(",")}|${f.content.trim()}`),
  ].join("\n");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** Parse a single bracket-prefixed fact line into register/tags/content. */
function parseFactLine(text: string): DumpFact | null {
  let rest = text.trim();

  // Peel up to two leading [ ... ] groups. The first that is exactly a valid
  // register IS the register; anything else is a tag list. Everything after is
  // the fact content.
  const groups: string[] = [];
  for (let i = 0; i < 2; i++) {
    const m = rest.match(LEADING_BRACKET);
    if (!m) break;
    groups.push(m[1]);
    rest = rest.slice(m[0].length);
  }

  let register: Register = "craft"; // section default (§2.4) — favors capture over strictness
  let tagSource = "";
  if (groups.length === 1) {
    // One bracket: register if it names one, otherwise it's the tag list.
    const asReg = RegisterSchema.safeParse(groups[0].trim().toLowerCase());
    if (asReg.success) register = asReg.data;
    else tagSource = groups[0];
  } else if (groups.length === 2) {
    const asReg = RegisterSchema.safeParse(groups[0].trim().toLowerCase());
    if (asReg.success) register = asReg.data;
    // If the first group wasn't a register it's a stray — the second is the tags.
    tagSource = groups[1];
  }

  const tags = normalizeTags(tagSource);
  const content = rest.trim();
  if (!content) return null; // a bracket-only bullet has nothing to store
  return { register, tags, content };
}

/** Keep only valid vocabulary tags; default to `context` so min(1) always holds. */
function normalizeTags(source: string): string[] {
  const seen = new Set<string>();
  for (const raw of source.split(",")) {
    const t = raw.trim().toLowerCase();
    if (t && (ALL_TAGS as readonly string[]).includes(t)) seen.add(t);
  }
  if (seen.size === 0) return ["context"]; // unknown/absent tags → default
  return [...seen].slice(0, 5); // MemorySchema hard cap
}

/** Parse one block's inner text (between the sentinels) into a ParsedDump. */
function parseBlock(version: string, inner: string, unterminated: boolean): ParsedDump {
  const lines = inner.split("\n");
  const rawHeader: Record<string, string> = {};

  // Header: key: value lines at the top until the first `## ` section heading.
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (SECTION_HEADING.test(line)) break;
    if (line.trim() === "") continue;
    const m = line.match(HEADER_PAIR);
    if (m) rawHeader[m[1].toLowerCase()] = m[2].trim();
    // Non-header, non-heading noise before the first section is ignored (graceful).
  }

  // Sections: gather episode body and durable-facts bullets.
  let episodeLines: string[] | null = null;
  const facts: DumpFact[] = [];
  let section: "episode" | "facts" | "other" | null = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const heading = line.match(SECTION_HEADING);
    if (heading) {
      const name = heading[1].toLowerCase();
      if (name === "episode") { section = "episode"; episodeLines = []; }
      else if (/durable facts/.test(name)) section = "facts";
      else section = "other"; // unknown section — captured but unused
      continue;
    }
    if (section === "episode" && episodeLines) {
      episodeLines.push(line);
    } else if (section === "facts") {
      const bullet = line.match(BULLET);
      if (bullet) {
        const fact = parseFactLine(bullet[1]);
        if (fact) facts.push(fact);
      } else if (line.trim() !== "" && facts.length > 0) {
        // A wrapped continuation of the previous bullet — append (graceful capture).
        facts[facts.length - 1].content += " " + line.trim();
      }
    }
  }

  const episode = episodeLines ? episodeLines.join("\n").trim() : "";
  const whenRaw = rawHeader["when"];
  const salienceRaw = (rawHeader["salience"] ?? "").toLowerCase();

  const dump: ParsedDump = {
    version,
    when: whenRaw && ISO_DATE.test(whenRaw) ? whenRaw : undefined,
    with: rawHeader["with"] || undefined,
    surface: rawHeader["surface"] || undefined,
    title: rawHeader["title"] || undefined,
    salience: SALIENCE_LEVELS.includes(salienceRaw as SalienceLevel)
      ? (salienceRaw as SalienceLevel)
      : undefined,
    episode: episode || undefined,
    facts,
    hash: "", // filled below (needs the assembled fields)
    unterminated,
    rawHeader,
  };
  dump.hash = dumpHash(dump);
  return dump;
}

/**
 * Parse a pasted string into zero or more dump blocks. Splits on the sentinels
 * and processes each block independently; text outside the sentinels is ignored.
 * A block opened but never closed is captured to the next opening sentinel (or
 * EOF) and flagged `unterminated` — never dropped. Empty blocks (no episode, no
 * facts) are returned too (flagged via isEmptyDump); the drain skips them but
 * still archives their file, distinguishing a well-formed-but-empty dump from a
 * truly malformed file (which yields zero blocks).
 */
export function parseDumps(text: string): ParsedDump[] {
  const lines = text.split("\n");
  const dumps: ParsedDump[] = [];

  let i = 0;
  while (i < lines.length) {
    const open = lines[i].match(OPEN_SENTINEL);
    if (!open) { i++; continue; }

    const version = open[1];
    const body: string[] = [];
    let j = i + 1;
    let unterminated = true;
    for (; j < lines.length; j++) {
      if (CLOSE_SENTINEL.test(lines[j])) { unterminated = false; break; }
      if (OPEN_SENTINEL.test(lines[j])) { unterminated = true; break; } // next block starts — this one never closed
      body.push(lines[j]);
    }
    dumps.push(parseBlock(version, body.join("\n"), unterminated));
    // Resume after the close line; if we stopped on a new OPEN, re-examine it.
    i = unterminated ? j : j + 1;
  }

  return dumps;
}
