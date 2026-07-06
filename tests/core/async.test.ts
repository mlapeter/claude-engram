import { describe, it, expect } from "vitest";
import { withTimeout, TimeoutError } from "../../src/core/async.js";

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
