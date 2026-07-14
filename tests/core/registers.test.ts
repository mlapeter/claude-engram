import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore, type MemoryStore } from "../../src/core/store.js";
import { generateId, registerOf } from "../../src/core/types.js";
import type { Memory } from "../../src/core/types.js";
import { resetConfig, isObserverMode } from "../../src/core/config.js";
import { calculateStrength } from "../../src/core/strength.js";
import { applyConsolidation, mergedSalience } from "../../src/core/consolidation.js";
import { episodeBlockReason, EPISODE_REASK_HOURS } from "../../src/core/episodes.js";

vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: vi.fn() }; } }));

let tempDir: string;
let store: MemoryStore;

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: generateId(),
    content: "test memory content",
    scope: "project",
    memory_type: "episodic",
    salience: { novelty: 0.5, relevance: 0.5, emotional: 0.3, predictive: 0.5 },
    tags: ["technical"],
    access_count: 0,
    last_accessed: null,
    created_at: new Date().toISOString(),
    consolidated: false,
    generalized: false,
    source_session: "test-session",
    updated_from: null,
    ...overrides,
  };
}

const SALIENCE = { novelty: 0.5, relevance: 0.5, emotional: 0.5, predictive: 0.5 };
const emptyResult = () => ({ merge: [], generalize: [], prune_ids: [], notes: "" });

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "engram-registers-test-"));
  process.env.ENGRAM_DATA_DIR = tempDir;
  delete process.env.VOYAGE_API_KEY;
  delete process.env.ENGRAM_OBSERVER;
  writeFileSync(join(tempDir, "config.json"), JSON.stringify({ memoryHistory: false }));
  resetConfig();
  store = createStore(process.cwd());
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.ENGRAM_DATA_DIR;
  delete process.env.ENGRAM_OBSERVER;
  resetConfig();
});

describe("registerOf — explicit field wins, tags classify the back-catalog", () => {
  it("honors an explicit register", () => {
    expect(registerOf({ register: "craft", tags: ["relationship"] })).toBe("craft");
  });
  it("classifies self tags", () => {
    expect(registerOf({ tags: ["self-reflection", "pattern"] })).toBe("self");
    expect(registerOf({ tags: ["realization"] })).toBe("self");
  });
  it("classifies person tags", () => {
    expect(registerOf({ tags: ["relationship", "technical"] })).toBe("person");
    expect(registerOf({ tags: ["personal"] })).toBe("person");
  });
  it("high emotional salience without tags reads as person", () => {
    expect(registerOf({ tags: ["technical"], salience: { emotional: 0.9 } })).toBe("person");
  });
  it("defaults to craft", () => {
    expect(registerOf({ tags: ["technical", "project"] })).toBe("craft");
  });
});

describe("consolidation — registers never mix", () => {
  it("refuses a merge whose sources span registers, even when the model proposes it", async () => {
    const person = makeMemory({ id: "m_1_pers", register: "person", content: "a tender moment" });
    const craft = makeMemory({ id: "m_2_craf", register: "craft", content: "a technical fact" });
    await store.add([person, craft]);

    const result = await applyConsolidation(store, [person, craft], {
      ...emptyResult(),
      merge: [{
        ids: ["m_1_pers", "m_2_craf"],
        merged: { content: "should not exist", salience: SALIENCE, tags: ["pattern"] },
      }],
    }, 0, 0);

    expect(result.mergeCount).toBe(0);
    const active = await store.loadAll();
    expect(active.map((m) => m.id).sort()).toEqual(["m_1_pers", "m_2_craf"]);
  });

  it("merges within a register and stamps the register on the result", async () => {
    const a = makeMemory({ id: "m_1_aaaa", register: "person" });
    const b = makeMemory({ id: "m_2_bbbb", register: "person" });
    await store.add([a, b]);

    await applyConsolidation(store, [a, b], {
      ...emptyResult(),
      merge: [{
        ids: ["m_1_aaaa", "m_2_bbbb"],
        merged: { content: "merged person memory", salience: SALIENCE, tags: ["relationship"] },
      }],
    }, 0, 0);

    const merged = (await store.loadAll()).find((m) => m.consolidated)!;
    expect(merged.register).toBe("person");
  });
});

describe("merge salience conservation (2026-07-14 river-trip regression)", () => {
  it("merged salience is the component-wise max of sources — the model's re-score is ignored", async () => {
    const a = makeMemory({
      id: "m_1_srca", register: "person",
      salience: { novelty: 0.6, relevance: 0.85, emotional: 0.55, predictive: 0.75 },
    });
    const b = makeMemory({
      id: "m_2_srcb", register: "person",
      salience: { novelty: 0.5, relevance: 0.8, emotional: 0.6, predictive: 0.75 },
    });
    await store.add([a, b]);

    await applyConsolidation(store, [a, b], {
      ...emptyResult(),
      merge: [{
        ids: ["m_1_srca", "m_2_srcb"],
        // The model tries to re-judge the pair down to ~0.375 — the exact slash
        // that buried the trip memory. Deduplication must never make a memory
        // matter less.
        merged: {
          content: "merged trip memory",
          salience: { novelty: 0.3, relevance: 0.5, emotional: 0.4, predictive: 0.3 },
          tags: ["relationship"],
        },
      }],
    }, 0, 0);

    const merged = (await store.loadAll()).find((m) => m.consolidated)!;
    expect(merged.salience).toEqual({ novelty: 0.6, relevance: 0.85, emotional: 0.6, predictive: 0.75 });
  });

  it("mergedSalience survives missing and NaN components", () => {
    const broken = [
      { salience: { novelty: NaN, relevance: 0.4 } },
      { salience: undefined },
    ] as unknown as Memory[];
    expect(mergedSalience(broken)).toEqual({ novelty: 0, relevance: 0.4, emotional: 0, predictive: 0 });
  });
});

describe("register decay physics", () => {
  it("craft decays faster than person at the same age and salience", () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString();
    const craft = makeMemory({ register: "craft", created_at: tenDaysAgo });
    const person = makeMemory({ register: "person", created_at: tenDaysAgo });
    expect(calculateStrength(craft)).toBeLessThan(calculateStrength(person));
  });

  it("fresh memories are unaffected by the multiplier", () => {
    const craft = makeMemory({ register: "craft" });
    const person = makeMemory({ register: "person" });
    expect(calculateStrength(craft)).toBeCloseTo(calculateStrength(person), 3);
  });
});

describe("observer mode", () => {
  it("is off by default", () => {
    expect(isObserverMode()).toBe(false);
  });
  it("reads the config file fresh (no restart needed)", () => {
    writeFileSync(join(tempDir, "config.json"), JSON.stringify({ observerMode: true }));
    expect(isObserverMode()).toBe(true);
    writeFileSync(join(tempDir, "config.json"), JSON.stringify({ observerMode: false }));
    expect(isObserverMode()).toBe(false);
  });
  it("honors the env var override", () => {
    process.env.ENGRAM_OBSERVER = "1";
    expect(isObserverMode()).toBe(true);
  });
});

describe("episode re-ask for long-lived sessions", () => {
  it("asks again when the session's newest episode is older than the re-ask window", () => {
    const marker = "abcd1234";
    const episodesDir = join(tempDir, "episodes");
    rmSync(episodesDir, { recursive: true, force: true });
    // write an episode, then pretend time passed
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(episodesDir, { recursive: true });
    writeFileSync(join(episodesDir, `2026-07-04-${marker}.md`), "chapter one");

    // within the window → no ask
    expect(episodeBlockReason(`${marker}-rest-of-uuid`)).toBeNull();
    // past the window → ask for chapter 2
    const later = Date.now() + (EPISODE_REASK_HOURS + 1) * 3600_000;
    const reason = episodeBlockReason(`${marker}-rest-of-uuid`, later);
    expect(reason).toBeTruthy();
    expect(reason).toContain(`${marker}-2.md`);
    expect(reason).toContain("earlier episode");
  });
});
