import { readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import type { TranscriptCursor } from "./types.js";
import { log } from "./logger.js";

const MAX_CHARS = 12_000; // ~3000 tokens rough estimate

export interface TranscriptResult {
  content: string;
  newCursor: TranscriptCursor;
}

/**
 * Read new transcript content from a cursor position.
 * Returns only content added since the cursor's byte offset.
 */
export function readTranscriptFromCursor(
  path: string,
  cursor: TranscriptCursor,
  sessionId: string,
): TranscriptResult {
  let offset = cursor.byteOffset;

  // New session → reset cursor
  if (cursor.lastSessionId && cursor.lastSessionId !== sessionId) {
    offset = 0;
  }

  let fileSize: number;
  try {
    fileSize = statSync(path).size;
  } catch {
    return {
      content: "",
      newCursor: { byteOffset: 0, lastSessionId: sessionId },
    };
  }

  if (offset >= fileSize) {
    return {
      content: "",
      newCursor: { byteOffset: offset, lastSessionId: sessionId },
    };
  }

  // Read bytes from offset to end
  const bytesToRead = fileSize - offset;
  const buffer = Buffer.alloc(bytesToRead);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, bytesToRead, offset);
  } finally {
    closeSync(fd);
  }

  const raw = buffer.toString("utf-8");
  const content = parseLines(raw);

  return {
    content: truncateContent(content),
    newCursor: { byteOffset: fileSize, lastSessionId: sessionId },
  };
}

/**
 * Parse the full transcript (or from an offset), returning formatted content.
 */
export function parseFullTranscript(path: string, afterOffset?: number): string {
  let raw: string;
  try {
    if (afterOffset && afterOffset > 0) {
      const fileSize = statSync(path).size;
      if (afterOffset >= fileSize) return "";
      const bytesToRead = fileSize - afterOffset;
      const buffer = Buffer.alloc(bytesToRead);
      const fd = openSync(path, "r");
      try {
        readSync(fd, buffer, 0, bytesToRead, afterOffset);
      } finally {
        closeSync(fd);
      }
      raw = buffer.toString("utf-8");
    } else {
      raw = readFileSync(path, "utf-8");
    }
  } catch {
    return "";
  }

  return truncateContent(parseLines(raw));
}

function parseLines(raw: string): string {
  const lines = raw.split("\n").filter((l) => l.trim());
  const parts: string[] = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      const formatted = formatEntry(obj);
      if (formatted) parts.push(formatted);
    } catch {
      // Malformed line — skip silently
      log("warn", `Malformed transcript line: ${line.substring(0, 100)}`);
    }
  }

  return parts.join("\n\n");
}

function formatEntry(obj: unknown): string | null {
  if (!obj || typeof obj !== "object") return null;
  const entry = obj as Record<string, unknown>;

  // Handle direct conversation messages (role at top level)
  const role = entry.role as string | undefined;
  if (role === "user" || role === "assistant") {
    const content = extractContent(entry.content);
    if (content) {
      return `[${role}]: ${content}`;
    }
  }

  // Handle Claude Code transcript wrapper format:
  // {type: "user"|"assistant", message: {role: "user"|"assistant", content: ...}}
  const entryType = entry.type as string | undefined;
  if ((entryType === "user" || entryType === "assistant") && entry.message) {
    return formatEntry(entry.message);
  }

  // Handle generic message wrapper
  if (entryType === "message" && entry.message) {
    return formatEntry(entry.message);
  }

  // Skip tool use, system events, etc.
  return null;
}

function extractContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textParts = content
      .filter((c) => c && typeof c === "object" && c.type === "text" && c.text)
      .map((c) => c.text as string);
    return textParts.length > 0 ? textParts.join(" ") : null;
  }
  return null;
}

function truncateContent(content: string): string {
  if (content.length <= MAX_CHARS) return content;

  // Prioritize recent messages — take from the end
  const sections = content.split("\n\n");
  const result: string[] = [];
  let totalLen = 0;

  for (let i = sections.length - 1; i >= 0; i--) {
    const section = sections[i];
    if (totalLen + section.length + 2 > MAX_CHARS) break;
    result.unshift(section);
    totalLen += section.length + 2;
  }

  return result.join("\n\n");
}
