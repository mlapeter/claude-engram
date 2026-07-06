import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore } from "../../src/core/store.js";
import { runConsolidation, isLockStale, isPidAlive } from "../../src/core/consolidation.js";
import { resetConfig } from "../../src/core/config.js";

let tempDir: string;
let lockPath: string;

/** A PID that is essentially guaranteed dead (near the PID ceiling). */
const DEAD_PID = 99999998;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "engram-lock-test-"));
  process.env.ENGRAM_DATA_DIR = tempDir;
  delete process.env.VOYAGE_API_KEY;
  lockPath = join(tempDir, "consolidation.lock");
  resetConfig();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.ENGRAM_DATA_DIR;
  resetConfig();
});

function ageFile(path: string, minutesAgo: number) {
  const t = new Date(Date.now() - minutesAgo * 60_000);
  utimesSync(path, t, t);
}

describe("isPidAlive", () => {
  it("reports this process as alive", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("reports a dead pid as dead", () => {
    expect(isPidAlive(DEAD_PID)).toBe(false);
  });
});

describe("isLockStale — PID-aware", () => {
  it("a lock whose holder is dead is stale immediately, regardless of age", () => {
    writeFileSync(lockPath, String(DEAD_PID));
    expect(isLockStale(lockPath)).toBe(true);
  });

  it("a lock whose holder is alive is respected, even when old", () => {
    writeFileSync(lockPath, String(process.pid));
    ageFile(lockPath, 60);
    expect(isLockStale(lockPath)).toBe(false);
  });

  it("falls back to age for locks without a readable pid: fresh is held", () => {
    writeFileSync(lockPath, "not-a-pid");
    expect(isLockStale(lockPath)).toBe(false);
  });

  it("falls back to age for locks without a readable pid: old is stale", () => {
    writeFileSync(lockPath, "not-a-pid");
    ageFile(lockPath, 15);
    expect(isLockStale(lockPath)).toBe(true);
  });
});

describe("runConsolidation lock behavior", () => {
  it("skips when a live process holds the lock, even an old one", async () => {
    writeFileSync(lockPath, String(process.pid));
    ageFile(lockPath, 60); // pre-PID-awareness this would have been stolen

    const store = createStore(process.cwd());
    const result = await runConsolidation(store);

    expect(result.notes).toContain("Skipped");
    expect(existsSync(lockPath)).toBe(true); // still held by the "other" process
  });

  it("steals an orphaned lock (dead holder) and runs", async () => {
    writeFileSync(lockPath, String(DEAD_PID));

    const store = createStore(process.cwd());
    const result = await runConsolidation(store);

    expect(result.notes).not.toContain("Skipped");
    expect(existsSync(lockPath)).toBe(false); // released after the run
  });

  it("releases the lock after a normal run", async () => {
    const store = createStore(process.cwd());
    await runConsolidation(store);
    expect(existsSync(lockPath)).toBe(false);
  });
});
