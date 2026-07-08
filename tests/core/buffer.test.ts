import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendToBuffer, bufferStats, claimBuffer, clearClaim, restoreBuffer,
  restoreBufferText, lastSessionInBuffer, bufferPath,
  splitBufferIntoChunks, countSpanHeaders,
} from "../../src/core/buffer.js";
import { ageInDays, getCurrentActiveDay, resetActiveDayCache } from "../../src/core/active-day.js";

let tempDir: string;
const CWD = "/fake/project";

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "engram-buffer-test-"));
  process.env.ENGRAM_DATA_DIR = tempDir;
  resetActiveDayCache();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.ENGRAM_DATA_DIR;
  resetActiveDayCache();
});

describe("buffer — durable encoding", () => {
  it("appends spans with session headers and tracks size + oldest age", () => {
    appendToBuffer(CWD, "sess-1111", "first span of content");
    appendToBuffer(CWD, "sess-2222", "second span");

    const stats = bufferStats(CWD);
    expect(stats.bytes).toBeGreaterThan(40);
    expect(stats.oldestMs).toBeTypeOf("number");
    expect(Date.now() - stats.oldestMs!).toBeLessThan(5000);

    const content = readFileSync(bufferPath(CWD), "utf-8");
    expect(content).toContain("session sess-1111");
    expect(content).toContain("first span of content");
    expect(lastSessionInBuffer(content)).toBe("sess-2222");
  });

  it("claim is atomic: buffer is renamed away, new appends land in a fresh buffer", () => {
    appendToBuffer(CWD, "sess-1111", "x".repeat(300));
    const claimed = claimBuffer(CWD);
    expect(claimed).toContain("x".repeat(300));
    expect(existsSync(bufferPath(CWD))).toBe(false);

    appendToBuffer(CWD, "sess-2222", "arrived during extraction");
    expect(readFileSync(bufferPath(CWD), "utf-8")).toContain("arrived during extraction");

    clearClaim(CWD); // success — claim consumed, new content untouched
    expect(readFileSync(bufferPath(CWD), "utf-8")).toContain("arrived during extraction");
  });

  it("restore returns claimed content to the buffer without clobbering new spans", () => {
    appendToBuffer(CWD, "sess-1111", "y".repeat(300));
    claimBuffer(CWD);
    appendToBuffer(CWD, "sess-2222", "new span");

    restoreBuffer(CWD);

    const content = readFileSync(bufferPath(CWD), "utf-8");
    expect(content).toContain("y".repeat(300));
    expect(content).toContain("new span");
  });

  it("merges a leftover claim from a crashed run into the next claim", () => {
    appendToBuffer(CWD, "sess-1111", "a".repeat(300));
    claimBuffer(CWD); // crash here — claim file left behind
    appendToBuffer(CWD, "sess-2222", "b".repeat(300));

    const second = claimBuffer(CWD);
    expect(second).toContain("a".repeat(300));
    expect(second).toContain("b".repeat(300));
  });

  it("returns scraps to the buffer instead of burning an extraction call", () => {
    appendToBuffer(CWD, "sess-1111", "tiny");
    expect(claimBuffer(CWD, 200)).toBeNull();
    expect(existsSync(bufferPath(CWD))).toBe(true); // still buffered for later
  });

  it("claims nothing when no buffer exists", () => {
    expect(claimBuffer(CWD)).toBeNull();
  });
});

// A span exactly as appendToBuffer writes it: header line + body + blank line.
const span = (session: string, body: string) =>
  `--- 2026-07-08T00:00:00.000Z session ${session} ---\n${body}\n\n`;

describe("splitBufferIntoChunks — header-boundary chunking", () => {
  it("packs whole spans up to the byte budget, never splitting mid-span", () => {
    const s1 = span("aaaa", "x".repeat(100));
    const s2 = span("bbbb", "y".repeat(100));
    const s3 = span("cccc", "z".repeat(100));
    const s4 = span("dddd", "w".repeat(100));
    const content = s1 + s2 + s3 + s4;

    const chunks = splitBufferIntoChunks(content, 320); // ~2 spans per chunk

    // Every chunk begins on a span header (no mid-span split) and holds whole spans.
    for (const c of chunks) {
      expect(c.startsWith("--- ")).toBe(true);
      expect(countSpanHeaders(c)).toBeGreaterThanOrEqual(1);
      expect(Buffer.byteLength(c, "utf-8")).toBeLessThanOrEqual(320);
    }
    expect(chunks.length).toBeGreaterThan(1);
    // Lossless: the chunks reconstruct the exact input, so failed chunks restore verbatim.
    expect(chunks.join("")).toBe(content);
    // Every span survives exactly once.
    expect(countSpanHeaders(chunks.join(""))).toBe(4);
  });

  it("keeps a span whole even when it alone exceeds the budget (oversized single-span chunk)", () => {
    const small = span("aaaa", "x".repeat(50));
    const huge = span("bbbb", "y".repeat(2000));
    const content = small + huge;

    const chunks = splitBufferIntoChunks(content, 500);

    // The huge span is its own chunk — never dropped, never split.
    const oversized = chunks.filter((c) => Buffer.byteLength(c, "utf-8") > 500);
    expect(oversized).toHaveLength(1);
    expect(countSpanHeaders(oversized[0])).toBe(1);
    expect(oversized[0]).toContain("y".repeat(2000));
    expect(chunks.join("")).toBe(content); // still lossless
  });

  it("returns a single chunk when everything fits, and nothing for empty input", () => {
    const content = span("aaaa", "small") + span("bbbb", "also small");
    expect(splitBufferIntoChunks(content, 32768)).toEqual([content]);
    expect(splitBufferIntoChunks("", 1000)).toEqual([]);
  });

  it("countSpanHeaders counts the session headers in a slice", () => {
    expect(countSpanHeaders(span("a", "one") + span("b", "two"))).toBe(2);
    expect(countSpanHeaders(span("a", "one"))).toBe(1);
    expect(countSpanHeaders("no headers here")).toBe(0);
  });
});

describe("partial-failure restore", () => {
  it("returns only the failed chunk's text; successful chunks stay consumed", () => {
    appendToBuffer(CWD, "sess-1111", "a".repeat(300));
    appendToBuffer(CWD, "sess-2222", "b".repeat(300));
    appendToBuffer(CWD, "sess-3333", "c".repeat(300));

    const claimed = claimBuffer(CWD)!;
    const chunks = splitBufferIntoChunks(claimed, 400); // one span per chunk

    // Simulate the runner: chunk 1 fails, chunks 0 and 2 succeed (memories stored).
    restoreBufferText(CWD, chunks[1]);
    clearClaim(CWD);

    const restored = readFileSync(bufferPath(CWD), "utf-8");
    expect(restored).toContain("b".repeat(300)); // failed span is back for a retry
    expect(restored).not.toContain("a".repeat(300)); // succeeded spans are gone
    expect(restored).not.toContain("c".repeat(300));
    expect(countSpanHeaders(restored)).toBe(1);
  });

  it("restored failed text coexists with spans that arrived during extraction", () => {
    appendToBuffer(CWD, "sess-1111", "a".repeat(300));
    const claimed = claimBuffer(CWD)!;
    appendToBuffer(CWD, "sess-2222", "arrived mid-extraction");

    restoreBufferText(CWD, claimed); // whole claim failed
    clearClaim(CWD);

    const restored = readFileSync(bufferPath(CWD), "utf-8");
    expect(restored).toContain("a".repeat(300));
    expect(restored).toContain("arrived mid-extraction");
  });
});

describe("active-day clock", () => {
  it("reads the counter from global meta and caches", () => {
    mkdirSync(join(tempDir, "global"), { recursive: true });
    writeFileSync(join(tempDir, "global", "meta.json"), JSON.stringify({ activeDay: 42 }));
    resetActiveDayCache();
    expect(getCurrentActiveDay()).toBe(42);
  });

  it("ages by active days when stamped, calendar days otherwise", () => {
    mkdirSync(join(tempDir, "global"), { recursive: true });
    writeFileSync(join(tempDir, "global", "meta.json"), JSON.stringify({ activeDay: 50 }));
    resetActiveDayCache();

    const tenCalendarDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString();
    // created on active day 48, two active days ago — even though a month of calendar time could have passed
    expect(ageInDays({ created_at: tenCalendarDaysAgo, created_active_day: 48 })).toBe(2);
    // unstamped memory falls back to calendar age
    expect(ageInDays({ created_at: tenCalendarDaysAgo })).toBeCloseTo(10, 0);
  });

  it("a month away costs nothing: same active day = zero age", () => {
    mkdirSync(join(tempDir, "global"), { recursive: true });
    writeFileSync(join(tempDir, "global", "meta.json"), JSON.stringify({ activeDay: 10 }));
    resetActiveDayCache();
    const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString();
    expect(ageInDays({ created_at: monthAgo, created_active_day: 10 })).toBe(0);
  });
});
