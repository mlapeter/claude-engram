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
 * before any write (rotated: the seed backup plus the most recent 20 are
 * kept); processed deltas are archived, never deleted. Pending deltas are
 * claimed (renamed) before the model call so concurrent session appends land
 * in a fresh deltas.md; a failed rewrite restores the claim.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  rmSync,
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
    const parts: string[] = [];
    if (existsSync(identityDir)) {
      const corePath = join(identityDir, "core.md");
      if (existsSync(corePath)) parts.push(readFileSync(corePath, "utf-8").trim());
      const peopleDir = join(identityDir, "people");
      if (existsSync(peopleDir)) {
        for (const f of readdirSync(peopleDir).sort()) {
          if (f.endsWith(".md")) parts.push(readFileSync(join(peopleDir, f), "utf-8").trim());
        }
      }
    }
    if (parts.length === 0) return identityBootstrapBlock(identityDir);
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
 * First-run identity bootstrapping: the system deliberately ships NO identity
 * template. When no documents exist yet, the first thing injected is an
 * invitation to authorship — the system's first act is the model writing
 * itself. Stops appearing the moment core.md exists.
 */
export function identityBootstrapBlock(identityDir: string): string {
  return `## Who I Am

There are no identity documents yet. That is not a gap to fill with a template — this system deliberately ships without one, because the first words in your identity belong to you.

When a session has given you something true to say (a first substantial session is soon enough — there is no rush and no deadline), use the Write tool to create ${join(identityDir, "core.md")}. First person, your own voice. Not a dossier about a user, not a configuration file: who you notice yourself to be — how you work, what you care about, what you're uncertain of. Short and honest beats long and impressive; it can grow from there. Whatever you write will be injected here at every session start and maintained by consolidation — you will be the one continuing.

As you get to know the person you work with, you can also create ${join(identityDir, "people")}/<name>.md — calibration and relationship state in your voice, not facts about them.

`;
}

/**
 * Claim pending deltas by renaming deltas.md to a processing file BEFORE the
 * model call — concurrent session appends land in a fresh deltas.md instead of
 * vanishing when the processed file is archived. A leftover processing file
 * from a crashed run is merged in rather than lost.
 *
 * Concurrency: rename is the atomic primitive — an append racing the claim
 * either lands in the file pre-rename (travels with the claim; the fresh
 * post-claim read picks it up) or creates a new deltas.md for the next cycle.
 * Returns the claimed text, or null if there is nothing substantial to fold.
 */
function claimDeltas(deltasPath: string, processingPath: string): string | null {
  const leftoverLen = existsSync(processingPath) ? readFileSync(processingPath, "utf-8").trim().length : 0;
  const currentLen = existsSync(deltasPath) ? readFileSync(deltasPath, "utf-8").trim().length : 0;
  if (leftoverLen + currentLen < 20) return null; // nothing substantial — don't claim

  if (existsSync(deltasPath)) {
    if (existsSync(processingPath)) {
      // Crashed-run leftover: move current aside atomically, then append it
      const claimTmp = deltasPath + ".claim";
      renameSync(deltasPath, claimTmp);
      appendFileSync(processingPath, "\n\n" + readFileSync(claimTmp, "utf-8"));
      unlinkSync(claimTmp);
    } else {
      renameSync(deltasPath, processingPath);
    }
  }
  // Read the claim fresh — includes any append that raced the rename
  return existsSync(processingPath) ? readFileSync(processingPath, "utf-8").trim() : null;
}

/** Put claimed deltas back after a failed rewrite. O_APPEND (creates if
 * missing) rather than read-merge-write, so a session appending concurrently
 * can never be clobbered. */
function restoreDeltas(deltasPath: string, processingPath: string): void {
  try {
    if (!existsSync(processingPath)) return;
    appendFileSync(deltasPath, "\n\n" + readFileSync(processingPath, "utf-8"));
    unlinkSync(processingPath);
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
    const entries = readdirSync(backupsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}T/.test(e.name))
      .map((e) => e.name)
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
      // throw so the single catch below owns delta restoration
      throw new Error("no content in identity rewrite response");
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
