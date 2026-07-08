import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreate = vi.fn();

// Mock the Anthropic SDK before importing salience
vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
  },
}));

import { extractMemories } from "../../src/core/salience.js";
import { sanitizeSalience } from "../../src/core/types.js";
import type { Memory } from "../../src/core/types.js";

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
    mockCreate.mockReset();
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

  it("API error THROWS — the runner must restore the buffer, not mistake outage for 'nothing durable'", async () => {
    mockCreate.mockRejectedValueOnce(new Error("API quota exceeded"));

    await expect(extractMemories("some input", [], "transcript")).rejects.toThrow("API quota exceeded");
  });

  it("truncated output (stop_reason max_tokens) THROWS — a mid-string JSON cutoff must fail loudly so the chunk restores", async () => {
    mockCreate.mockResolvedValueOnce({
      stop_reason: "max_tokens",
      content: [{ type: "text", text: '{"memories":[{"content":"half a memo' }],
    });

    await expect(extractMemories("a very long arc", [], "transcript")).rejects.toThrow("truncated at max_tokens");
  });

  it("uses an 8000-token output budget by default and honors an override for oversized spans", async () => {
    const ok = {
      content: [{ type: "text", text: JSON.stringify({ memories: [] }) }],
    };
    mockCreate.mockResolvedValueOnce(ok);
    await extractMemories("input", [], "transcript");
    expect(mockCreate.mock.calls[0][0].max_tokens).toBe(8000);

    mockCreate.mockResolvedValueOnce(ok);
    await extractMemories("oversized single span", [], "transcript", null, 16000);
    expect(mockCreate.mock.calls[1][0].max_tokens).toBe(16000);
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

  it("salience > 1.0 is clamped before validation (prevents batch loss)", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            memories: [
              {
                content: "Memory with out-of-range salience",
                scope: "global",
                salience: { novelty: 0.8, relevance: 1.2, emotional: 1.5, predictive: 0.9 },
                tags: ["test"],
                updates: null,
              },
              {
                content: "Normal memory in same batch",
                scope: "global",
                salience: { novelty: 0.5, relevance: 0.5, emotional: 0.5, predictive: 0.5 },
                tags: ["test"],
                updates: null,
              },
            ],
          }),
        },
      ],
    });

    const result = await extractMemories("test input", [], "transcript");
    // Both memories should survive — clamping prevents Zod rejection of entire batch
    expect(result).toHaveLength(2);
    expect(result[0].salience.relevance).toBeLessThanOrEqual(1);
    expect(result[0].salience.emotional).toBeLessThanOrEqual(1);
  });
});

describe("sanitizeSalience", () => {
  it("clamps values > 1.0 to 1.0", () => {
    const result = sanitizeSalience({ novelty: 1.5, relevance: 2.0, emotional: 1.1, predictive: 0.9 });
    expect(result.novelty).toBe(1);
    expect(result.relevance).toBe(1);
    expect(result.emotional).toBe(1);
    expect(result.predictive).toBe(0.9);
  });

  it("clamps negative values to 0", () => {
    const result = sanitizeSalience({ novelty: -0.5, relevance: -1, emotional: 0, predictive: 0.3 });
    expect(result.novelty).toBe(0);
    expect(result.relevance).toBe(0);
    expect(result.emotional).toBe(0);
    expect(result.predictive).toBe(0.3);
  });

  it("converts NaN and undefined to 0", () => {
    const result = sanitizeSalience({ novelty: NaN, relevance: undefined as any });
    expect(result.novelty).toBe(0);
    expect(result.relevance).toBe(0);
    expect(result.emotional).toBe(0);
    expect(result.predictive).toBe(0);
  });

  it("handles undefined input", () => {
    const result = sanitizeSalience(undefined);
    expect(result).toEqual({ novelty: 0, relevance: 0, emotional: 0, predictive: 0 });
  });

  it("passes through valid values unchanged", () => {
    const result = sanitizeSalience({ novelty: 0.5, relevance: 0.7, emotional: 0.3, predictive: 0.8 });
    expect(result).toEqual({ novelty: 0.5, relevance: 0.7, emotional: 0.3, predictive: 0.8 });
  });
});
