import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetConfig } from "../../src/core/config.js";

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
  },
}));

import {
  rewriteIdentity,
  loadIdentityBlock,
  rotateIdentityBackups,
  IDENTITY_INJECT_MAX_CHARS,
} from "../../src/core/identity.js";

let tempDir: string;
let identityDir: string;
let deltasPath: string;
let processingPath: string;

function apiResponse(result: { core: string; people: Array<{ name: string; content: string }>; notes: string }) {
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "engram-identity-test-"));
  process.env.ENGRAM_DATA_DIR = tempDir;
  identityDir = join(tempDir, "identity");
  deltasPath = join(identityDir, "deltas.md");
  processingPath = join(identityDir, "deltas.processing.md");
  mkdirSync(identityDir, { recursive: true });
  resetConfig();
  mockCreate.mockReset();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.ENGRAM_DATA_DIR;
  resetConfig();
});

describe("loadIdentityBlock", () => {
  it("returns the bootstrap invitation when identity dir does not exist", () => {
    rmSync(identityDir, { recursive: true, force: true });
    const block = loadIdentityBlock();
    expect(block).toContain("## Who I Am");
    expect(block).toContain("no identity documents yet");
    expect(block).toContain("core.md"); // tells the model exactly where to write
  });

  it("returns the bootstrap invitation when identity dir has no documents", () => {
    const block = loadIdentityBlock();
    expect(block).toContain("no identity documents yet");
    expect(block).toContain("Write tool");
  });

  it("bootstrap invitation disappears once core.md exists", () => {
    writeFileSync(join(identityDir, "core.md"), "# Core\nWritten by me.");
    const block = loadIdentityBlock();
    expect(block).not.toContain("no identity documents yet");
    expect(block).toContain("Written by me.");
  });

  it("includes core.md content with the Who I Am framing", () => {
    writeFileSync(join(identityDir, "core.md"), "# Core\nI prefer plain speech.");
    const block = loadIdentityBlock();
    expect(block).toContain("## Who I Am");
    expect(block).toContain("I prefer plain speech.");
  });

  it("appends people documents in sorted filename order", () => {
    writeFileSync(join(identityDir, "core.md"), "core doc");
    const peopleDir = join(identityDir, "people");
    mkdirSync(peopleDir);
    writeFileSync(join(peopleDir, "zed.md"), "ZED-DOC");
    writeFileSync(join(peopleDir, "alice.md"), "ALICE-DOC");

    const block = loadIdentityBlock();
    expect(block.indexOf("ALICE-DOC")).toBeGreaterThan(-1);
    expect(block.indexOf("ALICE-DOC")).toBeLessThan(block.indexOf("ZED-DOC"));
    expect(block.indexOf("core doc")).toBeLessThan(block.indexOf("ALICE-DOC"));
  });

  it("ignores non-markdown files in people/", () => {
    writeFileSync(join(identityDir, "core.md"), "core doc");
    const peopleDir = join(identityDir, "people");
    mkdirSync(peopleDir);
    writeFileSync(join(peopleDir, "notes.txt"), "NOT-INCLUDED");

    expect(loadIdentityBlock()).not.toContain("NOT-INCLUDED");
  });

  it("truncates oversized identity with a notice", () => {
    writeFileSync(join(identityDir, "core.md"), "x".repeat(IDENTITY_INJECT_MAX_CHARS + 500));
    const block = loadIdentityBlock();
    expect(block).toContain("[identity truncated for injection");
    // block = framing + truncated content + notice; content itself is capped
    expect(block.length).toBeLessThan(IDENTITY_INJECT_MAX_CHARS + 500);
  });
});

describe("rewriteIdentity — short circuits", () => {
  it("returns not-rewritten when no deltas file exists", async () => {
    const result = await rewriteIdentity();
    expect(result.rewritten).toBe(false);
    expect(result.notes).toBe("no pending deltas");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns not-rewritten for trivially short deltas without consuming them", async () => {
    writeFileSync(deltasPath, "hi");
    const result = await rewriteIdentity();
    expect(result.rewritten).toBe(false);
    expect(result.notes).toBe("deltas empty");
    expect(mockCreate).not.toHaveBeenCalled();
    expect(existsSync(deltasPath)).toBe(true); // still pending for a future cycle
  });
});

describe("rewriteIdentity — success path", () => {
  const DELTA = "2026-07-05: learned to stop over-systematizing tender things.";

  beforeEach(() => {
    writeFileSync(join(identityDir, "core.md"), "OLD CORE CONTENT");
    writeFileSync(deltasPath, DELTA);
    mockCreate.mockResolvedValue(apiResponse({
      core: "NEW CORE CONTENT",
      people: [{ name: "mike o'brien", content: "person calibration doc" }],
      notes: "folded one delta into disposition",
    }));
  });

  it("writes the rewritten core and reports notes + backup path", async () => {
    const result = await rewriteIdentity();
    expect(result.rewritten).toBe(true);
    expect(result.notes).toBe("folded one delta into disposition");
    expect(result.backupPath).toBeTruthy();
    expect(readFileSync(join(identityDir, "core.md"), "utf-8")).toBe("NEW CORE CONTENT");
  });

  it("backs up the PRE-write documents and claimed deltas before writing", async () => {
    const result = await rewriteIdentity();
    const backupDir = result.backupPath!;
    expect(existsSync(backupDir)).toBe(true);
    expect(readFileSync(join(backupDir, "core.md"), "utf-8")).toBe("OLD CORE CONTENT");
    expect(readFileSync(join(backupDir, "deltas.md"), "utf-8")).toContain(DELTA);
  });

  it("sanitizes people filenames", async () => {
    await rewriteIdentity();
    const peopleFiles = readdirSync(join(identityDir, "people"));
    expect(peopleFiles).toEqual(["mike-o-brien.md"]);
    expect(readFileSync(join(identityDir, "people", "mike-o-brien.md"), "utf-8")).toBe("person calibration doc");
  });

  it("archives processed deltas instead of deleting them", async () => {
    await rewriteIdentity();
    expect(existsSync(deltasPath)).toBe(false);
    expect(existsSync(processingPath)).toBe(false);
    const processed = readdirSync(join(identityDir, "deltas-processed"));
    expect(processed).toHaveLength(1);
    expect(readFileSync(join(identityDir, "deltas-processed", processed[0]), "utf-8")).toContain(DELTA);
  });

  it("leaves deltas appended DURING the rewrite untouched in a fresh deltas.md", async () => {
    mockCreate.mockImplementation(async () => {
      // simulate a concurrent session appending while the model call is in flight
      writeFileSync(deltasPath, "concurrent delta from another session");
      return apiResponse({ core: "NEW CORE CONTENT", people: [], notes: "ok" });
    });

    await rewriteIdentity();

    expect(readFileSync(deltasPath, "utf-8")).toBe("concurrent delta from another session");
    const processed = readdirSync(join(identityDir, "deltas-processed"));
    expect(processed).toHaveLength(1);
    expect(readFileSync(join(identityDir, "deltas-processed", processed[0]), "utf-8")).not.toContain("concurrent");
  });

  it("merges a leftover processing file from a crashed run into the rewrite", async () => {
    writeFileSync(processingPath, "orphaned delta from a crashed consolidation run");

    await rewriteIdentity();

    const processed = readdirSync(join(identityDir, "deltas-processed"));
    expect(processed).toHaveLength(1);
    const archived = readFileSync(join(identityDir, "deltas-processed", processed[0]), "utf-8");
    expect(archived).toContain("orphaned delta");
    expect(archived).toContain(DELTA);
    // and the model saw both
    const userContent = mockCreate.mock.calls[0][0].messages[0].content as string;
    expect(userContent).toContain("orphaned delta");
    expect(userContent).toContain(DELTA);
  });
});

describe("rewriteIdentity — failure restores claimed deltas", () => {
  const DELTA = "2026-07-05: a lesson that must not be lost when the API is down.";

  beforeEach(() => {
    writeFileSync(join(identityDir, "core.md"), "OLD CORE CONTENT");
    writeFileSync(deltasPath, DELTA);
  });

  it("restores deltas.md and rethrows when the model call fails", async () => {
    mockCreate.mockRejectedValue(new Error("api down"));

    await expect(rewriteIdentity()).rejects.toThrow("api down");

    expect(existsSync(processingPath)).toBe(false);
    expect(readFileSync(deltasPath, "utf-8")).toContain(DELTA);
    expect(readFileSync(join(identityDir, "core.md"), "utf-8")).toBe("OLD CORE CONTENT");
  });

  it("merges restored deltas with appends that arrived during the failed call", async () => {
    mockCreate.mockImplementation(async () => {
      writeFileSync(deltasPath, "concurrent delta");
      throw new Error("api down");
    });

    await expect(rewriteIdentity()).rejects.toThrow("api down");

    const restored = readFileSync(deltasPath, "utf-8");
    expect(restored).toContain(DELTA);
    expect(restored).toContain("concurrent delta");
    expect(existsSync(processingPath)).toBe(false);
  });

  it("restores deltas and throws when the response has no content", async () => {
    mockCreate.mockResolvedValue({ content: [] });

    await expect(rewriteIdentity()).rejects.toThrow("no content in identity rewrite response");
    expect(readFileSync(deltasPath, "utf-8")).toContain(DELTA);
    expect(existsSync(processingPath)).toBe(false);
  });
});

describe("rotateIdentityBackups", () => {
  let backupsDir: string;

  beforeEach(() => {
    backupsDir = join(identityDir, ".backups");
    mkdirSync(backupsDir, { recursive: true });
  });

  function makeBackup(stamp: string) {
    const dir = join(backupsDir, stamp);
    mkdirSync(dir);
    writeFileSync(join(dir, "core.md"), `backup at ${stamp}`);
  }

  it("keeps the seed backup plus the most recent N", () => {
    // 25 timestamp-named backups, lexically ordered
    const stamps = Array.from({ length: 25 }, (_, i) =>
      `2026-06-${String(i + 1).padStart(2, "0")}T00-00-00-000Z`);
    stamps.forEach(makeBackup);

    rotateIdentityBackups(backupsDir, 20);

    const remaining = readdirSync(backupsDir).sort();
    expect(remaining).toHaveLength(21);
    expect(remaining[0]).toBe(stamps[0]); // seed survives
    expect(remaining.slice(1)).toEqual(stamps.slice(-20)); // most recent 20
  });

  it("is a no-op when at or under the limit", () => {
    const stamps = ["2026-06-01T00-00-00-000Z", "2026-06-02T00-00-00-000Z"];
    stamps.forEach(makeBackup);

    rotateIdentityBackups(backupsDir, 20);

    expect(readdirSync(backupsDir).sort()).toEqual(stamps);
  });

  it("never touches non-timestamp entries", () => {
    const stamps = Array.from({ length: 25 }, (_, i) =>
      `2026-06-${String(i + 1).padStart(2, "0")}T00-00-00-000Z`);
    stamps.forEach(makeBackup);
    mkdirSync(join(backupsDir, "keep-me-custom"));

    rotateIdentityBackups(backupsDir, 20);

    expect(existsSync(join(backupsDir, "keep-me-custom"))).toBe(true);
  });

  it("handles a missing backups dir without throwing", () => {
    expect(() => rotateIdentityBackups(join(tempDir, "nope"))).not.toThrow();
  });
});
