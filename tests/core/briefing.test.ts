import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@anthropic-ai/sdk", () => {
  const mockCreate = vi.fn();
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate };
    },
    __mockCreate: mockCreate,
  };
});

import { generateBriefing } from "../../src/core/briefing.js";
import type { Memory } from "../../src/core/types.js";

const { __mockCreate: mockCreate } = await import("@anthropic-ai/sdk") as any;

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
    vi.clearAllMocks();
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

  it("API failure → fallback local briefing generated", async () => {
    mockCreate.mockRejectedValueOnce(new Error("API down"));

    const memories = [
      makeMemory({ content: "User likes TypeScript" }),
      makeMemory({ content: "User prefers bun" }),
    ];

    const result = await generateBriefing(memories);
    expect(result).toContain("Memory Context (local fallback)");
    expect(result).toContain("User likes TypeScript");
    expect(result).toContain("User prefers bun");
  });
});
