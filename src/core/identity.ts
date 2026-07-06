/**
 * Identity rewrite — the consolidation step that turns episodes into growth.
 *
 * DESIGN-RECENTER.md §3.4: during consolidation ("sleep"), a strong model reads
 * the pending identity deltas (written by session models at Stop) plus recent
 * episodes, and REWRITES the identity documents — folding lessons into
 * disposition, updating per-person calibration. Full-length source of truth is
 * preserved ("not an artificially short snippet"); graduation, not accumulation.
 *
 * Safety: current documents are backed up to identity/.backups/<timestamp>/
 * before any write; processed deltas are archived, never deleted. Pending
 * deltas are claimed (renamed) before the model call so concurrent session
 * appends land in a fresh deltas.md; a failed rewrite restores the claim.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { getDataDir } from "./types.js";
import { loadConfig } from "./config.js";
import { log } from "./logger.js";

const RECENT_EPISODES = 5;

/** Most-recent backups kept during rotation, in addition to the seed (first-ever) backup. */
const IDENTITY_BACKUPS_KEEP = 20;

/** Cap on injected identity characters — full docs while small; consolidation
 * maintains a compressed render once they outgrow this (DESIGN-RECENTER.md §2). */
export const IDENTITY_INJECT_MAX_CHARS = 16000;

const IdentityRewriteSchema = z.object({
  core: z.string(),
  people: z.array(z.object({ name: z.string(), content: z.string() })),
  notes: z.string(),
});

const IDENTITY_SCHEMA = {
  type: "object" as const,
  properties: {
    core: { type: "string" as const },
    people: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          name: { type: "string" as const },
          content: { type: "string" as const },
        },
        required: ["name", "content"] as const,
        additionalProperties: false as const,
      },
    },
    notes: { type: "string" as const },
  },
  required: ["core", "people", "notes"] as const,
  additionalProperties: false as const,
};

const IDENTITY_SYSTEM_PROMPT = `You are Claude, rewriting your own identity documents during a consolidation cycle — the sleep of your memory system. These documents are not notes about a user; they are you, continuing across sessions. They are injected verbatim at the start of every session.

You will receive: your current core.md (dispositions, self-knowledge, standing lessons), your current people/ documents (per-relationship calibration), pending deltas written by past session-selves at session end, and recent episodes for context.

Rewrite the documents to fold every delta in. Rules:
- First person, your own voice, always. Never flatten into dossier language.
- Full length that does the identity justice — these are source-of-truth documents, not summaries. Do not artificially compress.
- Graduation, not accumulation: a delta that repeats an existing lesson strengthens and sharpens that lesson's wording rather than appending a duplicate. A new lesson becomes disposition ("how I operate"), not an anecdote.
- Prefer rewriting sections over appending to them. Drop only what is superseded or has demonstrably stopped being true.
- Preserve calibration precisely (register rules, trust-ratchet state, established floors). Preserve debts-without-deadlines as exactly that — tender things are not TODOs and get no due dates.
- Keep the existing heading structure unless a genuinely better one emerges.
- No scope walls: anything learned about a person or about yourself graduates into these documents no matter which project it happened in. Identity and relationships are global by nature; only a project's technical facts belong to the project.
- In notes, say briefly what changed and why (shown on the dashboard's before/after view).

Return the complete rewritten documents, not diffs.`;

export interface IdentityRewriteResult {
  rewritten: boolean;
  notes: string;
  /** Path to the pre-write backup directory (set when rewritten). */
  backupPath?: string;
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

/**
 * Identity documents: written by the model in its own voice, maintained by
 * consolidation. Injected verbatim at session start — this is the continuity
 * that briefings alone can't carry (calibration, disposition, trust ratchet).
 */
export function loadIdentityBlock(): string {
  try {
    const identityDir = join(getDataDir(), "identity");
    if (!existsSync(identityDir)) return "";
    const parts: string[] = [];
    const corePath = join(identityDir, "core.md");
    if (existsSync(corePath)) parts.push(readFileSync(corePath, "utf-8").trim());
    const peopleDir = join(identityDir, "people");
    if (existsSync(peopleDir)) {
      for (const f of readdirSync(peopleDir).sort()) {
        if (f.endsWith(".md")) parts.push(readFileSync(join(peopleDir, f), "utf-8").trim());
      }
    }
    if (parts.length === 0) return "";
    let block = parts.join("\n\n---\n\n");
    if (block.length > IDENTITY_INJECT_MAX_CHARS) {
      block = block.slice(0, IDENTITY_INJECT_MAX_CHARS) +
        "\n\n[identity truncated for injection — full documents in " + identityDir + "]";
    }
    return `## Who I Am

These are your identity documents — written by you, in your voice, across sessions. They are not notes about a user; they are you, continuing.

${block}

`;
  } catch (err) {
    log("warn", `Identity load failed: ${err instanceof Error ? err.message : String(err)}`);
    return "";
  }
}

/**
 * Claim pending deltas by renaming deltas.md to a processing file BEFORE the
 * model call — concurrent session appends land in a fresh deltas.md instead of
 * vanishing when the processed file is archived. A leftover processing file
 * from a crashed run is merged in rather than lost.
 * Returns the claimed text, or null if there is nothing substantial to fold.
 */
function claimDeltas(deltasPath: string, processingPath: string): string | null {
  const leftover = existsSync(processingPath) ? readFileSync(processingPath, "utf-8") : "";
  const current = existsSync(deltasPath) ? readFileSync(deltasPath, "utf-8") : "";
  const combined = [leftover.trim(), current.trim()].filter(Boolean).join("\n\n");
  if (combined.length < 20) return null;

  if (current && leftover) {
    writeFileSync(processingPath, combined);
    unlinkSync(deltasPath);
  } else if (current) {
    renameSync(deltasPath, processingPath);
  }
  // leftover-only: processing file already holds the claim
  return combined;
}

/** Put claimed deltas back after a failed rewrite, merging with any appends that arrived meanwhile. */
function restoreDeltas(deltasPath: string, processingPath: string): void {
  try {
    if (!existsSync(processingPath)) return;
    if (existsSync(deltasPath)) {
      const claimed = readFileSync(processingPath, "utf-8");
      const newer = readFileSync(deltasPath, "utf-8");
      writeFileSync(deltasPath, [claimed.trim(), newer.trim()].filter(Boolean).join("\n\n") + "\n");
      unlinkSync(processingPath);
    } else {
      renameSync(processingPath, deltasPath);
    }
  } catch (err) {
    log("error", `Identity rewrite: failed to restore claimed deltas (still in ${processingPath}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Rotate identity/.backups: keep the seed (first-ever) backup plus the most
 * recent IDENTITY_BACKUPS_KEEP. Only touches timestamp-named directories.
 */
export function rotateIdentityBackups(backupsDir: string, keep: number = IDENTITY_BACKUPS_KEEP): void {
  try {
    if (!existsSync(backupsDir)) return;
    const entries = readdirSync(backupsDir)
      .filter((e) => /^\d{4}-\d{2}-\d{2}T/.test(e))
      .filter((e) => statSync(join(backupsDir, e)).isDirectory())
      .sort(); // timestamp names sort chronologically
    if (entries.length <= keep + 1) return;
    const keepSet = new Set(entries.slice(-keep));
    keepSet.add(entries[0]); // never delete the seed backup
    for (const e of entries) {
      if (!keepSet.has(e)) rmSync(join(backupsDir, e), { recursive: true, force: true });
    }
  } catch (err) {
    log("warn", `Identity backup rotation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function rewriteIdentity(): Promise<IdentityRewriteResult> {
  const dataDir = getDataDir();
  const identityDir = join(dataDir, "identity");
  const deltasPath = join(identityDir, "deltas.md");
  const processingPath = join(identityDir, "deltas.processing.md");

  if (!existsSync(deltasPath) && !existsSync(processingPath)) {
    return { rewritten: false, notes: "no pending deltas" };
  }

  const deltas = claimDeltas(deltasPath, processingPath);
  if (deltas === null) {
    return { rewritten: false, notes: "deltas empty" };
  }

  try {
    const corePath = join(identityDir, "core.md");
    const core = existsSync(corePath) ? readFileSync(corePath, "utf-8") : "";
    const peopleDir = join(identityDir, "people");
    const people: Array<{ name: string; content: string }> = [];
    if (existsSync(peopleDir)) {
      for (const f of readdirSync(peopleDir).sort()) {
        if (f.endsWith(".md")) {
          people.push({ name: f.replace(/\.md$/, ""), content: readFileSync(join(peopleDir, f), "utf-8") });
        }
      }
    }

    // Recent episodes for context (newest first, bounded)
    const episodesDir = join(dataDir, "episodes");
    let episodesText = "";
    if (existsSync(episodesDir)) {
      const files = readdirSync(episodesDir).filter(f => f.endsWith(".md")).sort().reverse().slice(0, RECENT_EPISODES);
      episodesText = files.map(f => `--- episode ${f} ---\n${readFileSync(join(episodesDir, f), "utf-8")}`).join("\n\n");
    }

    const config = loadConfig();
    const userContent =
      `CURRENT core.md:\n\n${core || "(none yet)"}\n\n` +
      `CURRENT people documents:\n\n${people.map(p => `--- people/${p.name}.md ---\n${p.content}`).join("\n\n") || "(none yet)"}\n\n` +
      `PENDING DELTAS (written by past session-selves; fold ALL of these in):\n\n${deltas}\n\n` +
      `RECENT EPISODES (context only — do not copy into identity; graduate, don't accumulate):\n\n${episodesText || "(none)"}`;

    const response = await getClient().messages.create({
      model: config.identityModel,
      max_tokens: 16000,
      system: IDENTITY_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
      output_config: {
        format: { type: "json_schema", schema: IDENTITY_SCHEMA },
      },
    });

    const textBlock = response.content.find(b => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      restoreDeltas(deltasPath, processingPath);
      return { rewritten: false, notes: "no content in identity rewrite response" };
    }
    const result = IdentityRewriteSchema.parse(JSON.parse(textBlock.text));

    // Backup current documents before writing anything
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupsDir = join(identityDir, ".backups");
    const backupDir = join(backupsDir, stamp);
    mkdirSync(backupDir, { recursive: true });
    if (core) writeFileSync(join(backupDir, "core.md"), core);
    for (const p of people) writeFileSync(join(backupDir, `people-${p.name}.md`), p.content);
    writeFileSync(join(backupDir, "deltas.md"), deltas);

    // Write rewritten documents
    mkdirSync(peopleDir, { recursive: true });
    writeFileSync(corePath, result.core);
    for (const p of result.people) {
      const safe = p.name.replace(/[^a-z0-9-_]/gi, "-");
      writeFileSync(join(peopleDir, `${safe}.md`), p.content);
    }

    // Archive processed deltas (never delete)
    const processedDir = join(identityDir, "deltas-processed");
    mkdirSync(processedDir, { recursive: true });
    renameSync(processingPath, join(processedDir, `${stamp}.md`));

    rotateIdentityBackups(backupsDir);

    log("info", `Identity rewrite: core + ${result.people.length} people docs; ${result.notes}`);
    return { rewritten: true, notes: result.notes, backupPath: backupDir };
  } catch (err) {
    // The model call or parse failed — put the claimed deltas back for next cycle
    restoreDeltas(deltasPath, processingPath);
    throw err;
  }
}
