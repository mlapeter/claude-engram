import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { projectHash } from "../../src/core/types.js";

/**
 * Integration tests for the Stop hook, run as a real bun subprocess (the hook
 * imports bun:sqlite, so it can't be imported under vitest/node).
 *
 * Post-B.7, the Stop hook is the ENCODING half only: it appends to the durable
 * buffer and never calls an API — keyless runs are the norm, not a drill.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HOOK = join(REPO_ROOT, "src/hooks/on-stop.ts");
const BUN = join(homedir(), ".bun/bin/bun");
const SESSION = "itest123-4567-8901-abcd";
const MARKER = SESSION.slice(0, 8);
const HOOK_TIMEOUT = 30_000;

let tempDir: string;
let transcriptPath: string;

function writeTranscript(lines: number, charsPerLine = 500) {
  const rows = Array.from({ length: lines }, (_, i) =>
    JSON.stringify({
      type: i % 2 === 0 ? "user" : "assistant",
      message: {
        role: i % 2 === 0 ? "user" : "assistant",
        content: `turn ${i}: ${"substantive discussion ".repeat(Math.ceil(charsPerLine / 23)).slice(0, charsPerLine)}`,
      },
    }));
  writeFileSync(transcriptPath, rows.join("\n") + "\n");
}

interface HookRun {
  stdout: string;
  stderr: string;
  code: number;
}

function runStopHook(input: Record<string, unknown>): Promise<HookRun> {
  return new Promise((resolvePromise, rejectPromise) => {
    // Keys set-but-EMPTY and cwd outside the repo: bun auto-loads .env from
    // the cwd, and set-but-empty vars take precedence — no real key can leak in
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ENGRAM_DATA_DIR: tempDir,
      ANTHROPIC_API_KEY: "",
      VOYAGE_API_KEY: "",
    };
    delete env.ENGRAM_DISABLE;

    const child = spawn(BUN, ["run", HOOK], { cwd: tempDir, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolvePromise({ stdout, stderr, code: code ?? -1 }));
    child.on("error", rejectPromise);
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

function hookInput(overrides: Record<string, unknown> = {}) {
  return {
    session_id: SESSION,
    transcript_path: transcriptPath,
    cwd: REPO_ROOT,
    stop_hook_active: false,
    ...overrides,
  };
}

const bufferFile = () => join(tempDir, "projects", projectHash(REPO_ROOT), "buffer.md");

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "engram-onstop-test-"));
  transcriptPath = join(tempDir, "transcript.jsonl");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("Stop hook (subprocess integration)", () => {
  it("appends the span to the durable buffer and emits the episode block — no API needed", async () => {
    writeTranscript(10); // ~5000 chars ≥ EPISODE_MIN_CONTENT

    const run = await runStopHook(hookInput());

    expect(run.code).toBe(0);
    // encoding half: span landed in the buffer with its session header
    expect(existsSync(bufferFile())).toBe(true);
    const buffered = readFileSync(bufferFile(), "utf-8");
    expect(buffered).toContain(`session ${SESSION}`);
    expect(buffered).toContain("substantive discussion");
    // self layer: episode ask fired
    const output = JSON.parse(run.stdout);
    expect(output.decision).toBe("block");
    expect(output.reason).toContain("[engram]");
  }, HOOK_TIMEOUT);

  it("passes through when stop_hook_active is set (anti-loop)", async () => {
    writeTranscript(10);

    const run = await runStopHook(hookInput({ stop_hook_active: true }));

    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
    expect(existsSync(bufferFile())).toBe(false); // no double-encoding
  }, HOOK_TIMEOUT);

  it("does not block again when the session's episode already exists", async () => {
    writeTranscript(10);
    const episodesDir = join(tempDir, "episodes");
    mkdirSync(episodesDir, { recursive: true });
    writeFileSync(join(episodesDir, `2026-07-05-${MARKER}.md`), "episode already written");

    const run = await runStopHook(hookInput());

    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
    expect(existsSync(bufferFile())).toBe(true); // still encoded
  }, HOOK_TIMEOUT);

  it("gates the episode ask on accumulated session experience, not just the turn", async () => {
    // short final turn, but the buffer already carries this session's history
    const bufDir = dirname(bufferFile());
    mkdirSync(bufDir, { recursive: true });
    writeFileSync(bufferFile(), `--- 2026-07-06T10:00:00.000Z session ${SESSION} ---\n${"earlier accumulated content ".repeat(150)}\n\n`);
    writeTranscript(1, 300);

    const run = await runStopHook(hookInput());

    expect(run.code).toBe(0);
    const output = JSON.parse(run.stdout);
    expect(output.decision).toBe("block"); // 300-char turn + ~4KB buffer ≥ threshold
  }, HOOK_TIMEOUT);

  it("does not request an episode for genuinely short sessions", async () => {
    writeTranscript(1, 300); // above MIN_CONTENT_LENGTH, below EPISODE_MIN_CONTENT

    const run = await runStopHook(hookInput());

    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
    expect(existsSync(bufferFile())).toBe(true); // still buffered
  }, HOOK_TIMEOUT);

  it("respects episodeSelfDump: false in config", async () => {
    writeTranscript(10);
    writeFileSync(join(tempDir, "config.json"), JSON.stringify({ episodeSelfDump: false }));

    const run = await runStopHook(hookInput());

    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
  }, HOOK_TIMEOUT);
});
