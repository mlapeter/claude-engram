import { describe, it, expect } from "vitest";
import { v1ToV4, v4ToV1, toV1Backup, isValidV1Backup } from "../../src/sync/schema.js";
import type { V1Memory } from "../../src/sync/schema.js";
import type { Memory } from "../../src/core/types.js";

function makeV1(overrides: Partial<V1Memory> = {}): V1Memory {
  return {
    id: "abc123",
    content: "test memory",
    salience: { novelty: 0.8, relevance: 0.7, emotional: 0.6, predictive: 0.5 },
    tags: ["identity"],
    accessCount: 3,
    lastAccessed: 1700000000000,
    createdAt: 1690000000000,
    consolidated: true,
    generalized: false,
    ...overrides,
  };
}

function makeV4(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "m_1700000000000_abcd",
    content: "test memory",
    scope: "global",
    memory_type: "episodic",
    salience: { novelty: 0.8, relevance: 0.7, emotional: 0.6, predictive: 0.5 },
    tags: ["identity"],
    access_count: 3,
    last_accessed: "2023-11-14T22:13:20.000Z",
    created_at: "2023-07-22T06:46:40.000Z",
    consolidated: true,
    generalized: false,
    source_session: "test",
    updated_from: null,
    ...overrides,
  };
}

describe("v1ToV4", () => {
  it("converts camelCase to snake_case and epoch to ISO", () => {
    const v1 = makeV1();
    const v4 = v1ToV4(v1);

    expect(v4.id).toMatch(/^m_\d+_\w+$/);
    expect(v4.content).toBe("test memory");
    expect(v4.scope).toBe("global"); // identity tag → global
    expect(v4.memory_type).toBe("episodic");
    expect(v4.access_count).toBe(3);
    expect(v4.last_accessed).toBe(new Date(1700000000000).toISOString());
    expect(v4.created_at).toBe(new Date(1690000000000).toISOString());
    expect(v4.consolidated).toBe(true);
    expect(v4.source_session).toBe("v1-sync");
  });

  it("assigns project scope for technical tags", () => {
    const v1 = makeV1({ tags: ["technical", "project"] });
    const v4 = v1ToV4(v1);
    expect(v4.scope).toBe("project");
  });

  it("handles null lastAccessed", () => {
    const v1 = makeV1({ lastAccessed: null });
    const v4 = v1ToV4(v1);
    expect(v4.last_accessed).toBeNull();
  });

  it("clamps salience values to [0, 1]", () => {
    const v1 = makeV1({
      salience: { novelty: 1.5, relevance: -0.3, emotional: NaN, predictive: 0.5 },
    });
    const v4 = v1ToV4(v1);
    expect(v4.salience.novelty).toBe(1);
    expect(v4.salience.relevance).toBe(0);
    expect(v4.salience.emotional).toBe(0);
    expect(v4.salience.predictive).toBe(0.5);
  });

  it("handles legacy importance/actionable fields", () => {
    const v1 = makeV1({
      salience: { importance: 0.9, actionable: 0.7 } as any,
    });
    const v4 = v1ToV4(v1);
    expect(v4.salience.novelty).toBe(0.9);
    expect(v4.salience.predictive).toBe(0.7);
  });

  it("truncates content to 400 chars", () => {
    const v1 = makeV1({ content: "x".repeat(500) });
    const v4 = v1ToV4(v1);
    expect(v4.content.length).toBe(400);
  });

  it("caps tags at 5", () => {
    const v1 = makeV1({ tags: ["a", "b", "c", "d", "e", "f", "g"] });
    const v4 = v1ToV4(v1);
    expect(v4.tags.length).toBe(5);
  });
});

describe("v4ToV1", () => {
  it("converts snake_case to camelCase and ISO to epoch", () => {
    const v4 = makeV4();
    const v1 = v4ToV1(v4);

    expect(v1.content).toBe("test memory");
    expect(v1.accessCount).toBe(3);
    // Roundtrip: epoch → ISO → epoch should preserve value
    expect(v1.lastAccessed).toBe(new Date("2023-11-14T22:13:20.000Z").getTime());
    expect(v1.createdAt).toBe(new Date("2023-07-22T06:46:40.000Z").getTime());
    expect(v1.consolidated).toBe(true);
    expect(v1.tags).toEqual(["identity"]);
  });

  it("handles null last_accessed", () => {
    const v4 = makeV4({ last_accessed: null });
    const v1 = v4ToV1(v4);
    expect(v1.lastAccessed).toBeNull();
  });

  it("generates v1-style ID", () => {
    const v4 = makeV4();
    const v1 = v4ToV1(v4);
    // v1 IDs are base36 timestamp + random
    expect(typeof v1.id).toBe("string");
    expect(v1.id.length).toBeGreaterThan(4);
  });
});

describe("toV1Backup", () => {
  it("wraps memories in v1 backup format", () => {
    const memories = [makeV4(), makeV4({ content: "another" })];
    const backup = toV1Backup(memories);

    expect(backup.memories.length).toBe(2);
    expect(backup.version).toBe("v3");
    expect(backup.exportedAt).toBeGreaterThan(0);
    expect(backup.memories[0].accessCount).toBe(3); // converted to camelCase
  });
});

describe("isValidV1Backup", () => {
  it("validates correct backup", () => {
    expect(isValidV1Backup({ memories: [] })).toBe(true);
    expect(isValidV1Backup({ memories: [makeV1()], version: "v3" })).toBe(true);
  });

  it("rejects invalid data", () => {
    expect(isValidV1Backup(null)).toBe(false);
    expect(isValidV1Backup({})).toBe(false);
    expect(isValidV1Backup({ memories: "not array" })).toBe(false);
    expect(isValidV1Backup("string")).toBe(false);
  });
});

describe("roundtrip", () => {
  it("v1 → v4 → v1 preserves core data", () => {
    const original = makeV1();
    const v4 = v1ToV4(original);
    const back = v4ToV1(v4);

    expect(back.content).toBe(original.content);
    expect(back.accessCount).toBe(original.accessCount);
    expect(back.consolidated).toBe(original.consolidated);
    expect(back.generalized).toBe(original.generalized);
    expect(back.tags).toEqual(original.tags);
    // Salience should be preserved
    expect(back.salience.novelty).toBeCloseTo(original.salience.novelty!, 5);
    expect(back.salience.emotional).toBeCloseTo(original.salience.emotional!, 5);
    // Timestamps should roundtrip (epoch → ISO → epoch)
    expect(back.createdAt).toBe(original.createdAt);
    expect(back.lastAccessed).toBe(original.lastAccessed);
  });
});
