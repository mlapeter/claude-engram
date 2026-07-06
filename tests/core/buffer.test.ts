import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendToBuffer, bufferStats, claimBuffer, clearClaim, restoreBuffer,
  lastSessionInBuffer, bufferPath,
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
