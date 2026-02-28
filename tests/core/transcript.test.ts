import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readTranscriptFromCursor, parseFullTranscript } from "../../src/core/transcript.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "engram-transcript-test-"));
  process.env.ENGRAM_DATA_DIR = tempDir;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.ENGRAM_DATA_DIR;
});

function writeTranscript(filename: string, lines: object[]): string {
  const path = join(tempDir, filename);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

describe("readTranscriptFromCursor", () => {
  it("reads full transcript on first call", () => {
    const path = writeTranscript("test.jsonl", [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ]);

    const result = readTranscriptFromCursor(path, { byteOffset: 0, lastSessionId: "" }, "session-1");

    expect(result.content).toContain("[user]: Hello");
    expect(result.content).toContain("[assistant]: Hi there!");
    expect(result.newCursor.byteOffset).toBeGreaterThan(0);
    expect(result.newCursor.lastSessionId).toBe("session-1");
  });

  it("cursor-based reading returns only new content", () => {
    const lines = [
      { role: "user", content: "First message" },
      { role: "assistant", content: "First reply" },
    ];
    const path = writeTranscript("test.jsonl", lines);

    // Read once to get cursor
    const first = readTranscriptFromCursor(path, { byteOffset: 0, lastSessionId: "" }, "session-1");

    // Append new content
    const newLine = JSON.stringify({ role: "user", content: "Second message" }) + "\n";
    const { appendFileSync } = require("node:fs");
    appendFileSync(path, newLine);

    // Read from cursor — should only get new content
    const second = readTranscriptFromCursor(path, first.newCursor, "session-1");
    expect(second.content).toContain("[user]: Second message");
    expect(second.content).not.toContain("First message");
  });

  it("session ID change resets cursor", () => {
    const path = writeTranscript("test.jsonl", [
      { role: "user", content: "Hello" },
    ]);

    // Read with session-1
    const first = readTranscriptFromCursor(path, { byteOffset: 0, lastSessionId: "" }, "session-1");

    // New session should reset
    const second = readTranscriptFromCursor(path, first.newCursor, "session-2");
    expect(second.content).toContain("[user]: Hello");
  });

  it("handles malformed lines gracefully", () => {
    const path = join(tempDir, "malformed.jsonl");
    writeFileSync(path, '{"role":"user","content":"good"}\nnot json at all\n{"role":"assistant","content":"ok"}\n');

    const result = readTranscriptFromCursor(path, { byteOffset: 0, lastSessionId: "" }, "session-1");
    expect(result.content).toContain("[user]: good");
    expect(result.content).toContain("[assistant]: ok");
  });

  it("empty/missing file handled", () => {
    const result = readTranscriptFromCursor("/nonexistent/file.jsonl", { byteOffset: 0, lastSessionId: "" }, "session-1");
    expect(result.content).toBe("");
    expect(result.newCursor.byteOffset).toBe(0);
  });

  it("handles content as array of text blocks", () => {
    const path = writeTranscript("test.jsonl", [
      { role: "assistant", content: [{ type: "text", text: "Part 1" }, { type: "text", text: "Part 2" }] },
    ]);

    const result = readTranscriptFromCursor(path, { byteOffset: 0, lastSessionId: "" }, "session-1");
    expect(result.content).toContain("Part 1 Part 2");
  });
});

describe("parseFullTranscript", () => {
  it("parses full transcript", () => {
    const path = writeTranscript("full.jsonl", [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "World" },
    ]);

    const content = parseFullTranscript(path);
    expect(content).toContain("[user]: Hello");
    expect(content).toContain("[assistant]: World");
  });

  it("truncation preserves recent messages", () => {
    const lines: object[] = [];
    for (let i = 0; i < 500; i++) {
      lines.push({ role: "user", content: `Message number ${i} with some padding text to make it longer` });
    }
    const path = writeTranscript("long.jsonl", lines);

    const content = parseFullTranscript(path);
    expect(content.length).toBeLessThanOrEqual(12_000);
    // Should contain recent messages
    expect(content).toContain("Message number 499");
  });

  it("skips tool use entries", () => {
    const path = writeTranscript("tools.jsonl", [
      { role: "user", content: "Hello" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read_file", input: {} }] },
      { role: "assistant", content: [{ type: "text", text: "Got it" }] },
    ]);

    const content = parseFullTranscript(path);
    expect(content).toContain("[user]: Hello");
    expect(content).toContain("[assistant]: Got it");
    expect(content).not.toContain("read_file");
  });
});
