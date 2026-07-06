import { describe, it, expect, afterEach } from "vitest";
import { withTimeout, TimeoutError, timeoutFromEnv } from "../../src/core/async.js";

describe("withTimeout", () => {
  it("resolves with the promise value when it finishes in time", async () => {
    const result = await withTimeout(Promise.resolve(42), 1000, "fast");
    expect(result).toBe(42);
  });

  it("rejects with TimeoutError when the promise is too slow", async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 5000));
    await expect(withTimeout(slow, 20, "slow op")).rejects.toThrow(TimeoutError);
  });

  it("includes the label and duration in the timeout message", async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 5000));
    await expect(withTimeout(slow, 20, "Stop extraction")).rejects.toThrow(
      "Stop extraction timed out after 20ms",
    );
  });

  it("propagates the underlying rejection when it fails in time", async () => {
    const failing = Promise.reject(new Error("api down"));
    await expect(withTimeout(failing, 1000, "op")).rejects.toThrow("api down");
  });
});

describe("timeoutFromEnv", () => {
  afterEach(() => {
    delete process.env.ENGRAM_TEST_TIMEOUT;
  });

  it("uses the default when unset", () => {
    expect(timeoutFromEnv("ENGRAM_TEST_TIMEOUT", 20_000)).toBe(20_000);
  });

  it("uses a positive override", () => {
    process.env.ENGRAM_TEST_TIMEOUT = "5000";
    expect(timeoutFromEnv("ENGRAM_TEST_TIMEOUT", 20_000)).toBe(5000);
  });

  it("rejects zero, negative, and garbage values", () => {
    for (const bad of ["0", "-1", "banana", ""]) {
      process.env.ENGRAM_TEST_TIMEOUT = bad;
      expect(timeoutFromEnv("ENGRAM_TEST_TIMEOUT", 20_000)).toBe(20_000);
    }
  });
});
