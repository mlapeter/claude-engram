#!/usr/bin/env bun

/**
 * LOCOMO Benchmark Eval Harness
 *
 * Measures claude-engram's memory recall quality against the LOCOMO benchmark —
 * the standard evaluation used by Mem0, Zep, Memobase, and other agent memory systems.
 *
 * Usage: ~/.bun/bin/bun run eval/locomo.ts
 */

import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Anthropic from "@anthropic-ai/sdk";
import { extractMemories } from "../src/core/salience.js";
import { createStore } from "../src/core/store.js";
import { generateId } from "../src/core/types.js";
import { resetConfig } from "../src/core/config.js";
import { calculateStrength } from "../src/core/strength.js";
import type { MemoryStore } from "../src/core/store.js";
import type { Memory } from "../src/core/types.js";

// --- Types ---

interface DialogTurn {
  speaker: string;
  text: string;
  date_time?: string;
}

interface QAItem {
  question: string;
  answer?: string | number;
  adversarial_answer?: string;
  category: number;
}

interface LocomoConversation {
  conversation: Record<string, unknown>;
  qa: QAItem[];
}

interface QuestionResult {
  conversationId: string;
  questionIdx: number;
  category: number;
  categoryName: string;
  question: string;
  goldAnswer: string;
  predictedAnswer: string;
  correct: boolean;
  judgeReason: string;
  memoriesRetrieved: number;
}

interface ConversationCheckpoint {
  conversationId: string;
  results: QuestionResult[];
  memoryCount: number;
}

type CheckpointMap = Record<string, ConversationCheckpoint>;

// --- Constants ---

const CATEGORY_NAMES: Record<number, string> = {
  1: "single-hop",
  2: "multi-hop",
  3: "temporal",
  4: "open-domain",
  5: "adversarial",
};

const EVAL_DIR = import.meta.dir;
const DATA_DIR = join(EVAL_DIR, "data");
const RESULTS_DIR = join(EVAL_DIR, "results");
const DATASET_PATH = join(DATA_DIR, "locomo10.json");
const CHECKPOINT_PATH = join(RESULTS_DIR, "checkpoint.json");
const DATASET_URL =
  "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json";

const RATE_LIMIT_MS = 400;
const MAX_RETRIES = 5;
const MODEL = "claude-haiku-4-5";

// --- API Client & Rate Limiting ---

const client = new Anthropic();
let lastApiCall = 0;

async function throttle(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastApiCall;
  if (elapsed < RATE_LIMIT_MS) {
    await new Promise((r) => setTimeout(r, RATE_LIMIT_MS - elapsed));
  }
  lastApiCall = Date.now();
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      await throttle();
      return await fn();
    } catch (error: unknown) {
      const status = (error as any)?.status;
      if ((status === 429 || status === 529) && attempt < MAX_RETRIES - 1) {
        const backoff = Math.min(1000 * 2 ** attempt, 30000);
        console.log(
          `  [retry] ${label}: ${status}, waiting ${backoff}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
        );
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      throw error;
    }
  }
  throw new Error(`${label}: max retries exceeded`);
}

// --- Dataset ---

async function ensureDataset(): Promise<LocomoConversation[]> {
  mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(DATASET_PATH)) {
    console.log("Downloading locomo10.json...");
    const response = await fetch(DATASET_URL);
    if (!response.ok) {
      throw new Error(
        `Failed to download dataset: ${response.status} ${response.statusText}`,
      );
    }
    const text = await response.text();
    writeFileSync(DATASET_PATH, text);
    console.log(`Downloaded to ${DATASET_PATH}`);
  }
  return JSON.parse(readFileSync(DATASET_PATH, "utf-8"));
}

// --- Checkpoint ---

function loadCheckpoint(): CheckpointMap {
  mkdirSync(RESULTS_DIR, { recursive: true });
  if (existsSync(CHECKPOINT_PATH)) {
    try {
      return JSON.parse(readFileSync(CHECKPOINT_PATH, "utf-8"));
    } catch {
      return {};
    }
  }
  return {};
}

function saveCheckpoint(checkpoint: CheckpointMap): void {
  writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint, null, 2));
}

// --- Session Formatting ---

function formatSession(sessionKey: string, turns: DialogTurn[], dateTime?: string): string {
  const dateInfo = dateTime ? `, ${dateTime}` : "";
  const sessionNum = sessionKey.replace("session_", "");
  const lines = [`[Session ${sessionNum}${dateInfo}]`];
  for (const turn of turns) {
    lines.push(`${turn.speaker}: ${turn.text}`);
  }
  return lines.join("\n");
}

// --- Ingestion ---

async function ingestConversation(
  conv: LocomoConversation,
  sampleId: string,
): Promise<{ store: MemoryStore; tempDir: string; memoryCount: number }> {
  const tempDir = mkdtempSync(join(tmpdir(), "engram-eval-"));
  process.env.ENGRAM_DATA_DIR = tempDir;
  resetConfig();
  const store = createStore("/eval/conv-" + sampleId);

  const conversation = conv.conversation;

  // Sort session keys numerically (not lexically)
  const sessionKeys = Object.keys(conversation)
    .filter(
      (key) => key.startsWith("session_") && Array.isArray(conversation[key]),
    )
    .sort(
      (a, b) =>
        parseInt(a.replace("session_", "")) -
        parseInt(b.replace("session_", "")),
    );

  console.log(`  Ingesting ${sessionKeys.length} sessions...`);

  for (const sessionKey of sessionKeys) {
    const turns = conversation[sessionKey] as DialogTurn[];
    const dateTime = conversation[`${sessionKey}_date_time`] as string | undefined;
    const transcript = formatSession(sessionKey, turns, dateTime);

    // Get existing memories for dedup context
    const existingMemories = await store.loadAll();

    const newMemories = await withRetry(
      () => extractMemories(transcript, existingMemories, "transcript"),
      `extract ${sampleId}/${sessionKey}`,
    );

    if (newMemories.length > 0) {
      const fullMemories = newMemories.map((m) => ({
        id: generateId(),
        content: m.content,
        scope: m.scope,
        memory_type: "episodic" as const,
        salience: m.salience,
        tags: m.tags,
        access_count: 0,
        last_accessed: null,
        created_at: new Date().toISOString(),
        consolidated: false,
        generalized: false,
        source_session: sessionKey,
        updated_from: m.updates,
      }));
      await store.add(fullMemories);
    }
  }

  const memoryCount = (await store.loadAll()).length;
  console.log(`  Extracted ${memoryCount} memories total`);

  return { store, tempDir, memoryCount };
}

// --- Answer Generation ---

async function generateAnswer(
  question: string,
  memories: Memory[],
): Promise<string> {
  if (memories.length === 0) {
    return "I don't know.";
  }

  const memoryContext = memories
    .map(
      (m, i) =>
        `${i + 1}. ${m.content} [strength: ${calculateStrength(m).toFixed(2)}]`,
    )
    .join("\n");

  const response = await withRetry(
    () =>
      client.messages.create({
        model: MODEL,
        max_tokens: 200,
        system:
          "Answer the question concisely using only the provided memories. If the memories don't contain enough information, say \"I don't know.\" Give a direct answer in 1-2 sentences.",
        messages: [
          {
            role: "user",
            content: `MEMORIES:\n${memoryContext}\n\nQUESTION: ${question}`,
          },
        ],
      }),
    "answer",
  );

  const textBlock = response.content.find((b) => b.type === "text");
  return textBlock?.type === "text" ? textBlock.text.trim() : "I don't know.";
}

// --- Judging ---

const JUDGE_SCHEMA = {
  type: "object" as const,
  properties: {
    correct: { type: "boolean" as const },
    reason: { type: "string" as const },
  },
  required: ["correct", "reason"] as const,
  additionalProperties: false as const,
};

async function judgeAnswer(
  question: string,
  goldAnswer: string,
  predictedAnswer: string,
): Promise<{ correct: boolean; reason: string }> {
  const response = await withRetry(
    () =>
      client.messages.create({
        model: MODEL,
        max_tokens: 200,
        system: [
          "You are a generous judge evaluating QA accuracy. Compare the predicted answer to the gold answer.",
          "Rules:",
          "- Accept paraphrasing, synonyms, and minor wording differences",
          "- Accept different date formats (e.g., \"May 12\" vs \"12th of May\" vs \"05/12\")",
          "- Accept partial answers that contain the key information",
          "- A predicted answer is CORRECT if it conveys the same core information as the gold answer",
          '- "I don\'t know" or refusals are WRONG unless the gold answer is also uncertain',
        ].join("\n"),
        messages: [
          {
            role: "user",
            content: `Question: ${question}\nGold Answer: ${goldAnswer}\nPredicted Answer: ${predictedAnswer}`,
          },
        ],
        output_config: {
          format: {
            type: "json_schema",
            schema: JUDGE_SCHEMA,
          },
        },
      }),
    "judge",
  );

  const textBlock = response.content.find((b) => b.type === "text");
  if (textBlock?.type === "text") {
    try {
      const parsed = JSON.parse(textBlock.text);
      return { correct: !!parsed.correct, reason: parsed.reason || "" };
    } catch {
      return { correct: false, reason: "Failed to parse judge response" };
    }
  }
  return { correct: false, reason: "No judge response" };
}

// --- Per-Conversation Processing ---

async function processConversation(
  sampleId: string,
  conv: LocomoConversation,
): Promise<ConversationCheckpoint> {
  // Ingest all sessions
  const { store, memoryCount } = await ingestConversation(conv, sampleId);

  // Filter to non-adversarial QA (categories 1-4) with valid answers
  const qaItems = conv.qa.filter(
    (q) => q.category >= 1 && q.category <= 4 && q.answer !== undefined,
  );

  console.log(`  Answering ${qaItems.length} questions...`);

  const results: QuestionResult[] = [];
  for (let i = 0; i < qaItems.length; i++) {
    const qa = qaItems[i];
    const goldAnswer = String(qa.answer);

    // Search memories for this question
    const memories = await store.search(qa.question, 15);

    // Generate answer from retrieved memories
    const predictedAnswer = await generateAnswer(qa.question, memories);

    // Judge correctness
    const judgment = await judgeAnswer(qa.question, goldAnswer, predictedAnswer);

    results.push({
      conversationId: sampleId,
      questionIdx: i,
      category: qa.category,
      categoryName: CATEGORY_NAMES[qa.category] || "unknown",
      question: qa.question,
      goldAnswer,
      predictedAnswer,
      correct: judgment.correct,
      judgeReason: judgment.reason,
      memoriesRetrieved: memories.length,
    });
  }

  return { conversationId: sampleId, results, memoryCount };
}

// --- Reporting ---

function pct(n: number, d: number): string {
  return d > 0 ? ((100 * n) / d).toFixed(1) + "%" : "N/A";
}

function printSummary(results: QuestionResult[]): void {
  console.log("\n" + "=".repeat(60));
  console.log("LOCOMO BENCHMARK RESULTS");
  console.log("=".repeat(60));

  // Overall
  const correct = results.filter((r) => r.correct).length;
  console.log(`\nOverall: ${correct}/${results.length} (${pct(correct, results.length)})`);

  // Per-category
  console.log("\nBy category:");
  for (const cat of [1, 2, 3, 4]) {
    const catResults = results.filter((r) => r.category === cat);
    if (catResults.length === 0) continue;
    const catCorrect = catResults.filter((r) => r.correct).length;
    const avgMemories =
      catResults.reduce((s, r) => s + r.memoriesRetrieved, 0) / catResults.length;
    console.log(
      `  ${CATEGORY_NAMES[cat].padEnd(12)} ${catCorrect}/${catResults.length} (${pct(catCorrect, catResults.length).padStart(6)})  avg memories retrieved: ${avgMemories.toFixed(1)}`,
    );
  }

  // Per-conversation
  console.log("\nBy conversation:");
  const byConv = new Map<string, QuestionResult[]>();
  for (const r of results) {
    if (!byConv.has(r.conversationId)) byConv.set(r.conversationId, []);
    byConv.get(r.conversationId)!.push(r);
  }
  for (const [convId, convResults] of byConv) {
    const convCorrect = convResults.filter((r) => r.correct).length;
    console.log(
      `  Conv ${convId.padStart(2)}: ${convCorrect}/${convResults.length} (${pct(convCorrect, convResults.length)})`,
    );
  }
}

// --- Main ---

async function main(): Promise<void> {
  // Validate API key before starting (extraction silently swallows auth errors)
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Error: ANTHROPIC_API_KEY environment variable is not set.");
    console.error("Export it before running: export ANTHROPIC_API_KEY=sk-ant-...");
    process.exit(1);
  }

  const startTime = Date.now();

  console.log("LOCOMO Benchmark Eval Harness");
  console.log("=============================\n");

  // Step 1: Ensure dataset
  const dataset = await ensureDataset();
  console.log(`Loaded ${dataset.length} conversations\n`);

  // Step 2: Load checkpoint for resume support
  const checkpoint = loadCheckpoint();
  const cached = Object.keys(checkpoint).length;
  if (cached > 0) {
    console.log(`Resuming: ${cached} conversations already completed\n`);
  }

  // Step 3: Process each conversation
  const allResults: QuestionResult[] = [];

  for (let i = 0; i < dataset.length; i++) {
    const sampleId = String(i);

    // Resume: skip completed conversations
    if (checkpoint[sampleId]) {
      const cp = checkpoint[sampleId];
      const correct = cp.results.filter((r) => r.correct).length;
      console.log(
        `[${i + 1}/${dataset.length}] Conv ${sampleId}: cached — ${cp.memoryCount} memories, ${correct}/${cp.results.length} correct`,
      );
      allResults.push(...cp.results);
      continue;
    }

    console.log(`[${i + 1}/${dataset.length}] Conv ${sampleId}:`);

    const result = await processConversation(sampleId, dataset[i]);
    checkpoint[sampleId] = result;
    saveCheckpoint(checkpoint);
    allResults.push(...result.results);

    const correct = result.results.filter((r) => r.correct).length;
    console.log(
      `  Result: ${correct}/${result.results.length} correct (${pct(correct, result.results.length)})\n`,
    );
  }

  // Step 4: Save full results
  mkdirSync(RESULTS_DIR, { recursive: true });
  const runTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const resultsPath = join(RESULTS_DIR, `run-${runTimestamp}.json`);
  writeFileSync(
    resultsPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        model: MODEL,
        totalConversations: dataset.length,
        totalQuestions: allResults.length,
        totalCorrect: allResults.filter((r) => r.correct).length,
        results: allResults,
      },
      null,
      2,
    ),
  );

  // Step 5: Print summary
  printSummary(allResults);

  const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
  console.log(`\nCompleted in ${elapsed} minutes`);
  console.log(`Results saved to ${resultsPath}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
