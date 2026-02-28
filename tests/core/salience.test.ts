import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Anthropic SDK before importing salience
vi.mock("@anthropic-ai/sdk", () => {
  const mockCreate = vi.fn();
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate };
    },
    __mockCreate: mockCreate,
  };
});

import { extractMemories } from "../../src/core/salience.js";
import type { Memory } from "../../src/core/types.js";

// Get the mock function
const { __mockCreate: mockCreate } = await import("@anthropic-ai/sdk") as any;

function makeExistingMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "m_existing_0001",
    content: "User prefers TypeScript",
    scope: "global",
    salience: { novelty: 0.5, relevance: 0.8, emotional: 0.2, predictive: 0.3 },
    tags: ["preference"],
    access_count: 2,
    last_accessed: null,
    created_at: new Date().toISOString(),
    consolidated: false,
    generalized: false,
    source_session: "prev-session",
    updated_from: null,
    ...overrides,
  };
}

describe("extractMemories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENGRAM_DATA_DIR = "/tmp/engram-test-salience";
  });

  it("valid extraction response parsed correctly", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            memories: [
              {
                content: "User likes bun over npm",
                scope: "global",
                salience: { novelty: 0.7, relevance: 0.8, emotional: 0.3, predictive: 0.5 },
                tags: ["preference"],
                updates: null,
              },
            ],
          }),
        },
      ],
    });

    const result = await extractMemories("User said they prefer bun", [], "transcript");
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("User likes bun over npm");
    expect(result[0].scope).toBe("global");
    expect(result[0].tags).toEqual(["preference"]);
  });

  it("scope routing based on tags", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            memories: [
              {
                content: "Project uses vitest for testing",
                scope: "project",
                salience: { novelty: 0.5, relevance: 0.9, emotional: 0.1, predictive: 0.4 },
                tags: ["technical", "project"],
                updates: null,
              },
            ],
          }),
        },
      ],
    });

    const result = await extractMemories("vitest is the test runner", [], "transcript");
    expect(result[0].scope).toBe("project");
  });

  it("empty input returns no memories", async () => {
    const result = await extractMemories("", [], "transcript");
    expect(result).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("API error returns empty array gracefully", async () => {
    mockCreate.mockRejectedValueOnce(new Error("API quota exceeded"));

    const result = await extractMemories("some input", [], "transcript");
    expect(result).toEqual([]);
  });

  it("passes existing memories for contradiction detection", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            memories: [
              {
                content: "User now prefers bun over npm",
                scope: "global",
                salience: { novelty: 0.8, relevance: 0.9, emotional: 0.3, predictive: 0.6 },
                tags: ["preference", "contradiction"],
                updates: "m_existing_0001",
              },
            ],
          }),
        },
      ],
    });

    const existing = [makeExistingMemory()];
    const result = await extractMemories("I switched from npm to bun", existing, "transcript");

    expect(result[0].updates).toBe("m_existing_0001");

    // Verify existing memories were passed to the API
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.messages[0].content).toContain("m_existing_0001");
  });
});
