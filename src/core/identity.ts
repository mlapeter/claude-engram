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
 * before any write; processed deltas are archived, never deleted.
 */

import Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { getDataDir } from "./types.js";
import { loadConfig } from "./config.js";
import { log } from "./logger.js";

const RECENT_EPISODES = 5;

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
- In notes, say briefly what changed and why (shown on the dashboard's before/after view).

Return the complete rewritten documents, not diffs.`;

export interface IdentityRewriteResult {
  rewritten: boolean;
  notes: string;
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

export async function rewriteIdentity(): Promise<IdentityRewriteResult> {
  const dataDir = getDataDir();
  const identityDir = join(dataDir, "identity");
  const deltasPath = join(identityDir, "deltas.md");

  if (!existsSync(deltasPath)) {
    return { rewritten: false, notes: "no pending deltas" };
  }
  const deltas = readFileSync(deltasPath, "utf-8").trim();
  if (deltas.length < 20) {
    return { rewritten: false, notes: "deltas empty" };
  }

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
    return { rewritten: false, notes: "no content in identity rewrite response" };
  }
  const result = IdentityRewriteSchema.parse(JSON.parse(textBlock.text));

  // Backup current documents before writing anything
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = join(identityDir, ".backups", stamp);
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
  renameSync(deltasPath, join(processedDir, `${stamp}.md`));

  log("info", `Identity rewrite: core + ${result.people.length} people docs; ${result.notes}`);
  return { rewritten: true, notes: result.notes };
}
