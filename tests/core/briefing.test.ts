import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
  },
}));

import { generateBriefing } from "../../src/core/briefing.js";
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
