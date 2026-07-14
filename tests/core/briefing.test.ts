import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
  },
}));

import { generateBriefing, presentStateLane } from "../../src/core/briefing.js";
import type { Memory } from "../../src/core/types.js";

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "m_test_0001",
    content: "test memory",
    scope: "global",
    salience: { novelty: 0.8, relevance: 0.7, emotional: 0.6, predictive: 0.5 },
    tags: ["identity"],
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

describe("generateBriefing", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    process.env.ENGRAM_DATA_DIR = "/tmp/engram-test-briefing";
  });

  it("zero memories → welcome message (no API call)", async () => {
    const result = await generateBriefing([]);
    expect(result).toContain("First session with engram");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("normal memories → API called with top 60", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: "## Active Context\n\nUser is building a memory system.",
        },
      ],
    });

    const memories = Array.from({ length: 70 }, (_, i) =>
      makeMemory({ id: `m_${i}`, content: `Memory ${i}` }),
    );

    const result = await generateBriefing(memories);
    expect(result).toContain("Active Context");
    expect(mockCreate).toHaveBeenCalledTimes(1);

    // Check that the input was limited to top 60
    const callArgs = mockCreate.mock.calls[0][0];
    const inputLines = callArgs.messages[0].content.split("\n").filter((l: string) => l.trim());
    expect(inputLines.length).toBeLessThanOrEqual(60);
  });

  it("context-adaptive: project memories sort higher with context", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "## Active Context\n\nProject-aware briefing." }],
    });

    // Global memory with higher salience
    const globalMem = makeMemory({
      id: "g1",
      content: "global fact",
      scope: "global",
      salience: { novelty: 0.8, relevance: 0.8, emotional: 0.8, predictive: 0.8 },
    });
    // Project memory with slightly lower salience
    const projectMem = makeMemory({
      id: "p1",
      content: "project detail",
      scope: "project",
      salience: { novelty: 0.7, relevance: 0.7, emotional: 0.7, predictive: 0.7 },
    });

    await generateBriefing([globalMem, projectMem], { cwd: "/Users/test/my-project", projectName: "my-project" });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockCreate.mock.calls[0][0];
    // System prompt should mention the project name
    expect(callArgs.system).toContain("my-project");
  });

  it("context-adaptive: no context → standard behavior", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "## Active Context\n\nStandard briefing." }],
    });

    const mem = makeMemory({ content: "some memory" });
    await generateBriefing([mem]);

    const callArgs = mockCreate.mock.calls[0][0];
    // System prompt should NOT contain project context
    expect(callArgs.system).not.toContain("starting in");
  });

  it("API failure → fallback local briefing generated", async () => {
    mockCreate.mockRejectedValueOnce(new Error("API down"));

    const memories = [
      makeMemory({ content: "User likes TypeScript" }),
      makeMemory({ content: "User prefers bun" }),
    ];

    const result = await generateBriefing(memories);
    expect(result).toContain("My Memory (local fallback)");
    expect(result).toContain("User likes TypeScript");
    expect(result).toContain("User prefers bun");
  });
});

describe("presentStateLane", () => {
  const now = new Date("2026-07-14T12:00:00Z");
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();

  beforeEach(() => {
    process.env.ENGRAM_DATA_DIR = "/tmp/engram-test-briefing";
  });

  it("carries a recent person-register memory verbatim, no model in between", () => {
    const trip = makeMemory({
      register: "person",
      content: "Mike left 2026-07-09 for a 3-day rafting trip on the North Fork of the Flathead",
      salience: { novelty: 0.6, relevance: 0.85, emotional: 0.55, predictive: 0.75 },
      created_at: daysAgo(6),
    });
    const lane = presentStateLane([trip], now);
    expect(lane).toContain("## Right now");
    expect(lane).toContain("rafting trip on the North Fork");
    expect(lane).toContain("(2026-07-08)"); // stamped with the memory's own date
  });

  it("excludes craft — the lane is for life, not work state", () => {
    const craft = makeMemory({
      register: "craft",
      content: "Refactored the recall ranking pipeline",
      created_at: daysAgo(1),
    });
    expect(presentStateLane([craft], now)).toBe("");
  });

  it("window runs on calendar days — a memory outside it expires", () => {
    const old = makeMemory({
      register: "person",
      content: "An older life fact",
      created_at: daysAgo(12),
    });
    expect(presentStateLane([old], now)).toBe("");
  });

  it("byte budget gates top-down by salience — no admission cliff", () => {
    const strong = makeMemory({
      register: "person",
      content: "High-salience life fact. " + "x".repeat(1200),
      salience: { novelty: 0.9, relevance: 0.9, emotional: 0.9, predictive: 0.9 },
      created_at: daysAgo(1),
    });
    const weak = makeMemory({
      register: "person",
      content: "Low-salience life fact that should be evicted by the budget. " + "y".repeat(600),
      salience: { novelty: 0.1, relevance: 0.1, emotional: 0.1, predictive: 0.1 },
      created_at: daysAgo(1),
    });
    const lane = presentStateLane([weak, strong], now);
    expect(lane).toContain("High-salience life fact");
    expect(lane).not.toContain("Low-salience life fact");
  });

  it("returns empty string when nothing qualifies", () => {
    expect(presentStateLane([], now)).toBe("");
  });
});
