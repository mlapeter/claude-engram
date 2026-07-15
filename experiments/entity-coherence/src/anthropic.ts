// Anthropic client: key resolution (env → repo-root .env fallback) and a retrying
// message call. Never prints the key.
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXPERIMENT_DIR } from "./fixture.ts";
import { MODEL, TEMPERATURE } from "./config.ts";

function resolveApiKey(): string {
  const fromEnv = process.env.ANTHROPIC_API_KEY;
  if (fromEnv && fromEnv.trim()) return fromEnv;
  // Fallback: parse ANTHROPIC_API_KEY= from the repo root .env (two dirs up).
  const envPath = join(EXPERIMENT_DIR, "..", "..", ".env");
  let raw: string;
  try {
    raw = readFileSync(envPath, "utf8");
  } catch {
    throw new Error(
      "ANTHROPIC_API_KEY not set and repo-root .env could not be read.",
    );
  }
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*ANTHROPIC_API_KEY\s*=\s*(.*)\s*$/);
    if (m) {
      let val = m[1].trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (val) return val;
    }
  }
  throw new Error("ANTHROPIC_API_KEY not found in environment or repo-root .env.");
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: resolveApiKey() });
  return client;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BACKOFF_MS = [1000, 4000, 15000];

type CallArgs = {
  system: string;
  user: string;
  maxTokens: number;
  label: string; // for error messages only
};

// Make one message call. Retry up to 3× on API errors with backoff. If the model
// stops on max_tokens, retry ONCE with 2× max_tokens. Throws on ultimate failure.
export async function callModel({ system, user, maxTokens, label }: CallArgs): Promise<string> {
  const c = getClient();
  let lastErr: unknown = null;

  // Initial attempt + up to 3 retries with 1s / 4s / 15s backoff.
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    if (attempt > 0) await sleep(BACKOFF_MS[attempt - 1]);
    try {
      let effectiveMax = maxTokens;
      let doubledOnce = false;
      // Inner loop lets a single attempt re-issue once for a max_tokens stop.
      for (;;) {
        const resp = await c.messages.create({
          model: MODEL,
          max_tokens: effectiveMax,
          temperature: TEMPERATURE,
          system,
          messages: [{ role: "user", content: user }],
        });

        if (resp.stop_reason === "max_tokens" && !doubledOnce) {
          doubledOnce = true;
          effectiveMax = maxTokens * 2;
          continue;
        }
        if (resp.stop_reason === "max_tokens") {
          throw new Error(
            `${label}: model hit max_tokens even after doubling to ${effectiveMax}.`,
          );
        }

        const text = resp.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");
        if (!text.trim()) {
          throw new Error(`${label}: empty response (stop_reason=${resp.stop_reason}).`);
        }
        return text;
      }
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `${label}: failed after ${BACKOFF_MS.length + 1} attempts. Last error: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

// Run tasks with bounded concurrency, preserving input order in the output.
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
