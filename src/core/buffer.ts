/**
 * The hippocampal buffer — durable, dumb, cheap encoding.
 *
 * Every Stop appends the turn's transcript span here in microseconds with no
 * API call; extraction (the expensive judgment) runs detached over whole arcs
 * at natural boundaries. The buffer is a plain text file: it survives crashes,
 * and extraction clears it only on success — a failed extraction restores the
 * claim, so experience is never lost between encoding and selection.
 */

import {
  existsSync,
  readFileSync,
  appendFileSync,
  renameSync,
  unlinkSync,
  statSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { getDataDir, projectHash } from "./types.js";
import { log } from "./logger.js";

export function bufferPath(cwd: string): string {
  return join(getDataDir(), "projects", projectHash(cwd), "buffer.md");
}

function extractingPath(cwd: string): string {
  return join(getDataDir(), "projects", projectHash(cwd), "buffer.extracting.md");
}

/** Append a turn's span. The header carries when + which session it came from. */
export function appendToBuffer(cwd: string, sessionId: string, content: string): void {
  const path = bufferPath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `--- ${new Date().toISOString()} session ${sessionId} ---\n${content}\n\n`);
}

export interface BufferStats {
  bytes: number;
  oldestMs: number | null; // epoch ms of the first (oldest) entry
}

/** Size + age of the oldest unflushed content (reads only the first header). */
export function bufferStats(cwd: string): BufferStats {
  const path = bufferPath(cwd);
  if (!existsSync(path)) return { bytes: 0, oldestMs: null };
  const bytes = statSync(path).size;
  let oldestMs: number | null = null;
  try {
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(64);
    readSync(fd, buf, 0, 64, 0);
    closeSync(fd);
    const m = buf.toString("utf-8").match(/^--- (\S+) session/);
    if (m) oldestMs = new Date(m[1]).getTime();
  } catch { /* unreadable header — treat as ageless */ }
  return { bytes, oldestMs };
}

/**
 * Claim the buffer for extraction (atomic rename). A leftover claim from a
 * crashed run is merged in rather than lost. Returns the claimed text, or
 * null when there is nothing substantial to extract.
 */
export function claimBuffer(cwd: string, minBytes: number = 200): string | null {
  const path = bufferPath(cwd);
  const claim = extractingPath(cwd);

  if (existsSync(path)) {
    if (existsSync(claim)) {
      const tmp = path + ".merge";
      renameSync(path, tmp);
      appendFileSync(claim, readFileSync(tmp, "utf-8"));
      unlinkSync(tmp);
    } else {
      renameSync(path, claim);
    }
  }
  if (!existsSync(claim)) return null;
  const content = readFileSync(claim, "utf-8");
  if (content.trim().length < minBytes) {
    // scraps — put them back for a future flush rather than burning a call
    restoreBuffer(cwd);
    return null;
  }
  return content;
}

/** Extraction succeeded — the claim is consumed. */
export function clearClaim(cwd: string): void {
  try { unlinkSync(extractingPath(cwd)); } catch { /* already gone */ }
}

/** Extraction failed — return the claim to the buffer (append: never clobbers
 * spans that arrived while extraction ran). */
export function restoreBuffer(cwd: string): void {
  const claim = extractingPath(cwd);
  try {
    if (!existsSync(claim)) return;
    appendFileSync(bufferPath(cwd), readFileSync(claim, "utf-8"));
    unlinkSync(claim);
  } catch (err) {
    log("error", `Buffer restore failed (claim preserved at ${claim}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The most recent session id mentioned in buffered content (for dedup windows). */
export function lastSessionInBuffer(content: string): string | null {
  const matches = [...content.matchAll(/^--- \S+ session (\S+) ---$/gm)];
  return matches.length ? matches[matches.length - 1][1] : null;
}
