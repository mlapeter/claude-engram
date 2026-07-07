import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { episodeBlockReason, EPISODE_MIN_CONTENT } from "../../src/core/episodes.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "engram-episodes-test-"));
  process.env.ENGRAM_DATA_DIR = tempDir;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.ENGRAM_DATA_DIR;
});

describe("episodeBlockReason", () => {
  it("returns instructions when no episode exists for the session", () => {
    const reason = episodeBlockReason("abcd1234-5678-uuid");
    expect(reason).toBeTruthy();
    expect(reason).toContain("[engram]");
    expect(reason).toContain("Write tool");
  });

  it("works when the episodes directory does not exist yet", () => {
    // No episodes/ dir in fresh tempDir — must not throw
    const reason = episodeBlockReason("abcd1234-5678-uuid");
    expect(reason).toBeTruthy();
  });

  it("targets a date-and-marker episode path in the data dir", () => {
    const reason = episodeBlockReason("abcd1234-5678-uuid")!;
    const date = new Date().toISOString().slice(0, 10);
    expect(reason).toContain(join(tempDir, "episodes", `${date}-abcd1234.md`));
  });

  it("points delta notes at identity/deltas.md and names both fold targets", () => {
    const reason = episodeBlockReason("abcd1234-5678-uuid")!;
    expect(reason).toContain(join(tempDir, "identity", "deltas.md"));
    expect(reason).toContain("identity/core.md (who you are)");
    expect(reason).toContain("identity/craft.md (how you work");
  });

  it("returns null when an episode with the session marker already exists", () => {
    const episodesDir = join(tempDir, "episodes");
    mkdirSync(episodesDir, { recursive: true });
    writeFileSync(join(episodesDir, "2026-07-05-abcd1234.md"), "already written");

    expect(episodeBlockReason("abcd1234-5678-uuid")).toBeNull();
  });

  it("matches the marker anywhere in the filename regardless of date", () => {
    const episodesDir = join(tempDir, "episodes");
    mkdirSync(episodesDir, { recursive: true });
    writeFileSync(join(episodesDir, "2020-01-01-abcd1234.md"), "old date, same session");

    expect(episodeBlockReason("abcd1234-5678-uuid")).toBeNull();
  });

  it("does not match episodes from other sessions", () => {
    const episodesDir = join(tempDir, "episodes");
    mkdirSync(episodesDir, { recursive: true });
    writeFileSync(join(episodesDir, "2026-07-05-ffff0000.md"), "different session");

    expect(episodeBlockReason("abcd1234-5678-uuid")).toBeTruthy();
  });

  it("exports a sane minimum content threshold", () => {
    expect(EPISODE_MIN_CONTENT).toBeGreaterThan(0);
  });
});
