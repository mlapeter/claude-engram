import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseDumps,
  isEmptyDump,
  dumpHash,
  salienceForFact,
  inboxFactScope,
} from "../../src/core/inbox.js";
import { drainInbox } from "../../src/core/consolidation.js";
import { createStore, type MemoryStore } from "../../src/core/store.js";
import { resetConfig } from "../../src/core/config.js";

// A complete, well-formed dump (fictional content).
const DUMP = `Here's your dump:

===ENGRAM DUMP v1===
when: 2026-07-08
with: Robin
surface: claude.ai
title: naming the tide-pool app
salience: high

## Episode
We argued about names and it stopped being about the name. Landed on "Ebb."

## Durable facts
- [craft] [project, technical] Robin's field-notes app is named "Ebb".
- [person] [relationship, preference] Robin distrusts apps that nag.
- [self] [insight, pattern] The "forgettable on purpose" principle generalizes.
===END ENGRAM DUMP v1===

trailing chatter outside the sentinels`;

describe("inbox parser — envelope", () => {
  it("parses a single well-formed dump, ignoring text outside the sentinels", () => {
    const dumps = parseDumps(DUMP);
    expect(dumps).toHaveLength(1);
    const d = dumps[0];
    expect(d.version).toBe("v1");
    expect(d.when).toBe("2026-07-08");
    expect(d.with).toBe("Robin");
    expect(d.surface).toBe("claude.ai");
    expect(d.title).toBe("naming the tide-pool app");
    expect(d.salience).toBe("high");
    expect(d.episode).toContain("Landed on \"Ebb.\"");
    expect(d.episode).not.toContain("trailing chatter");
    expect(d.facts).toHaveLength(3);
    expect(d.unterminated).toBe(false);
  });

  it("parses multiple blocks in one paste independently", () => {
    const paste = `${DUMP}\n\n===ENGRAM DUMP v1===\nwhen: 2026-07-09\n\n## Durable facts\n- [craft] [project] Second dump fact.\n===END ENGRAM DUMP v1===`;
    const dumps = parseDumps(paste);
    expect(dumps).toHaveLength(2);
    expect(dumps[1].when).toBe("2026-07-09");
    expect(dumps[1].facts[0].content).toBe("Second dump fact.");
    expect(dumps[1].episode).toBeUndefined();
  });

  it("returns nothing for a paste with no sentinels (malformed)", () => {
    expect(parseDumps("just some prose, no dump here")).toHaveLength(0);
    expect(parseDumps("")).toHaveLength(0);
  });

  it("captures an unterminated block to EOF and flags it", () => {
    const paste = `===ENGRAM DUMP v1===\nwhen: 2026-07-08\n\n## Episode\nNo closing sentinel here.`;
    const dumps = parseDumps(paste);
    expect(dumps).toHaveLength(1);
    expect(dumps[0].unterminated).toBe(true);
    expect(dumps[0].episode).toContain("No closing sentinel");
  });

  it("splits when a second block opens without the first closing", () => {
    const paste = `===ENGRAM DUMP v1===\n\n## Episode\nfirst\n===ENGRAM DUMP v1===\n\n## Episode\nsecond\n===END ENGRAM DUMP v1===`;
    const dumps = parseDumps(paste);
    expect(dumps).toHaveLength(2);
    expect(dumps[0].unterminated).toBe(true);
    expect(dumps[0].episode).toBe("first");
    expect(dumps[1].unterminated).toBe(false);
    expect(dumps[1].episode).toBe("second");
  });
});

describe("inbox parser — header fallbacks", () => {
  it("tolerates a missing header entirely", () => {
    const d = parseDumps("===ENGRAM DUMP v1===\n## Durable facts\n- plain fact\n===END ENGRAM DUMP v1===")[0];
    expect(d.when).toBeUndefined();
    expect(d.salience).toBeUndefined();
    expect(d.facts).toHaveLength(1);
  });

  it("drops a malformed date and an unrecognized salience level", () => {
    const d = parseDumps("===ENGRAM DUMP v1===\nwhen: last tuesday\nsalience: enormous\n\n## Episode\nx\n===END ENGRAM DUMP v1===")[0];
    expect(d.when).toBeUndefined();
    expect(d.salience).toBeUndefined();
  });

  it("ignores unknown header keys but keeps them in rawHeader", () => {
    const d = parseDumps("===ENGRAM DUMP v1===\nmood: elated\nwith: me\n\n## Episode\nx\n===END ENGRAM DUMP v1===")[0];
    expect(d.with).toBe("me");
    expect(d.rawHeader.mood).toBe("elated");
  });
});

describe("inbox parser — fact lines", () => {
  const facts = (line: string) =>
    parseDumps(`===ENGRAM DUMP v1===\n## Durable facts\n${line}\n===END ENGRAM DUMP v1===`)[0].facts;

  it("parses register + tags + content", () => {
    const f = facts("- [person] [relationship, preference] Robin distrusts nags.")[0];
    expect(f.register).toBe("person");
    expect(f.tags).toEqual(["relationship", "preference"]);
    expect(f.content).toBe("Robin distrusts nags.");
  });

  it("defaults a bracket-less bullet to craft + context", () => {
    const f = facts("- just a plain observation")[0];
    expect(f.register).toBe("craft");
    expect(f.tags).toEqual(["context"]);
    expect(f.content).toBe("just a plain observation");
  });

  it("treats a lone bracket as tags when it is not a register", () => {
    const f = facts("- [technical] a project fact")[0];
    expect(f.register).toBe("craft");
    expect(f.tags).toEqual(["technical"]);
    expect(f.content).toBe("a project fact");
  });

  it("treats a lone bracket as register when it names one", () => {
    const f = facts("- [self] a realization")[0];
    expect(f.register).toBe("self");
    expect(f.tags).toEqual(["context"]); // no tags given → default
    expect(f.content).toBe("a realization");
  });

  it("drops unknown tags and defaults when none survive", () => {
    const f = facts("- [craft] [banana, technical, xyzzy] fact")[0];
    expect(f.tags).toEqual(["technical"]);
  });

  it("supports asterisk bullets and skips bracket-only (empty) bullets", () => {
    const fs = facts("* [craft] a starred fact\n- [craft] [project]");
    expect(fs).toHaveLength(1);
    expect(fs[0].content).toBe("a starred fact");
  });

  it("appends a wrapped continuation line to the previous fact", () => {
    const f = facts("- [craft] first part\n  and the continuation")[0];
    expect(f.content).toBe("first part and the continuation");
  });
});

describe("inbox parser — empty detection", () => {
  it("flags a sentinel block with neither episode nor facts as empty", () => {
    const d = parseDumps("===ENGRAM DUMP v1===\nwhen: 2026-07-08\n===END ENGRAM DUMP v1===")[0];
    expect(isEmptyDump(d)).toBe(true);
  });
  it("a block with only facts is not empty", () => {
    const d = parseDumps("===ENGRAM DUMP v1===\n## Durable facts\n- a fact\n===END ENGRAM DUMP v1===")[0];
    expect(isEmptyDump(d)).toBe(false);
  });
});

describe("inbox parser — idempotency hash", () => {
  it("is stable across whitespace/header-cosmetic differences", () => {
    const a = parseDumps(DUMP)[0];
    const b = parseDumps(DUMP.replace(/\n\n/g, "\n\n\n").replace("trailing chatter outside the sentinels", ""))[0];
    expect(a.hash).toBe(b.hash);
  });
  it("changes when content changes", () => {
    const a = parseDumps(DUMP)[0];
    const b = parseDumps(DUMP.replace('named "Ebb"', 'named "Flow"'))[0];
    expect(a.hash).not.toBe(b.hash);
  });
  it("dumpHash is a pure function of the meaningful fields", () => {
    const h = dumpHash({ when: "2026-07-08", title: "t", episode: "e", facts: [] });
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(dumpHash({ when: "2026-07-08", title: " t ", episode: " e ", facts: [] })).toBe(h);
  });
});

describe("inbox salience & scope mapping", () => {
  it("maps coarse levels to a four-dimension vector, relevance leading", () => {
    const low = salienceForFact("low", "craft");
    const crit = salienceForFact("critical", "craft");
    expect(crit.relevance).toBeGreaterThan(low.relevance);
    expect(crit.predictive).toBeGreaterThan(low.predictive);
  });

  it("never lets a coarse header reach the sacred-verbatim threshold (0.75)", () => {
    for (const lvl of ["low", "medium", "high", "critical"] as const) {
      expect(salienceForFact(lvl, "person").emotional).toBeLessThan(0.75);
      expect(salienceForFact(lvl, "self").emotional).toBeLessThan(0.75);
    }
  });

  it("nudges person/self emotional above craft at the same level", () => {
    expect(salienceForFact("high", "person").emotional)
      .toBeGreaterThan(salienceForFact("high", "craft").emotional);
  });

  it("defaults an unknown level to medium", () => {
    expect(salienceForFact(undefined, "craft")).toEqual(salienceForFact("medium", "craft"));
  });

  it("routes to global by default, project only for project-ish tags", () => {
    expect(inboxFactScope(["insight", "pattern"])).toBe("global"); // no project-ish tag
    expect(inboxFactScope(["relationship"])).toBe("global");
    expect(inboxFactScope(["project", "technical"])).toBe("project");
    expect(inboxFactScope(["project", "preference"])).toBe("global"); // global tag breaks the tie
  });
});

describe("inbox drain — integration (API-free)", () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "engram-inbox-test-"));
    process.env.ENGRAM_DATA_DIR = tmpDir;
    process.env.VOYAGE_API_KEY = ""; // keyless: token-overlap dedup, no network
    resetConfig();
    store = createStore("/test/project");
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.ENGRAM_DATA_DIR;
    delete process.env.VOYAGE_API_KEY;
  });

  const writeInbox = (name: string, content: string) => {
    const dir = join(tmpDir, "inbox");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), content);
  };

  it("folds an episode + facts, then archives the raw file", async () => {
    writeInbox("paste-1.txt", DUMP);
    const r = await drainInbox(store);
    expect(r.files).toBe(1);
    expect(r.episodes).toBe(1);
    expect(r.facts).toBe(3);
    expect(r.failures).toHaveLength(0);

    // Episode landed with claude.ai provenance
    const episodes = readdirSync(join(tmpDir, "episodes"));
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toContain("claudeai");

    // Facts landed as candidate memories with the synthetic source session
    const mems = await store.loadAll();
    expect(mems.length).toBe(3);
    expect(mems.every((m) => m.source_session.startsWith("claudeai-"))).toBe(true);
    // self/person go global; the [project, technical] craft fact goes project
    expect(mems.filter((m) => m.scope === "project")).toHaveLength(1);

    // Raw file archived, not deleted
    expect(existsSync(join(tmpDir, "inbox", "paste-1.txt"))).toBe(false);
    expect(existsSync(join(tmpDir, "inbox", "processed", "paste-1.txt"))).toBe(true);
  });

  it("is idempotent: re-pasting the same dump does not double-encode the episode", async () => {
    writeInbox("paste-1.txt", DUMP);
    await drainInbox(store);
    writeInbox("paste-2.txt", DUMP); // same content, new file
    const r = await drainInbox(store);

    expect(r.episodes).toBe(0); // episode already exists — not re-written
    expect(r.facts).toBe(0); // facts dedup against the first drain
    expect(readdirSync(join(tmpDir, "episodes"))).toHaveLength(1);
    expect(existsSync(join(tmpDir, "inbox", "processed", "paste-2.txt"))).toBe(true);
  });

  it("leaves a malformed file in place and surfaces it", async () => {
    writeInbox("garbage.txt", "not a dump at all");
    const r = await drainInbox(store);
    expect(r.files).toBe(0);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("no ENGRAM DUMP block");
    // Never discarded
    expect(existsSync(join(tmpDir, "inbox", "garbage.txt"))).toBe(true);
    expect(existsSync(join(tmpDir, "inbox", "processed", "garbage.txt"))).toBe(false);
  });

  it("archives a well-formed-but-empty dump without folding anything", async () => {
    writeInbox("empty.txt", "===ENGRAM DUMP v1===\nwhen: 2026-07-08\n===END ENGRAM DUMP v1===");
    const r = await drainInbox(store);
    expect(r.files).toBe(1);
    expect(r.episodes).toBe(0);
    expect(r.facts).toBe(0);
    expect(r.failures).toHaveLength(0);
    expect(existsSync(join(tmpDir, "inbox", "processed", "empty.txt"))).toBe(true);
  });

  it("returns clean zeros when there is no inbox directory", async () => {
    const r = await drainInbox(store);
    expect(r).toEqual({ files: 0, episodes: 0, facts: 0, failures: [] });
  });
});
