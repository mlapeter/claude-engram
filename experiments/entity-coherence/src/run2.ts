// Run 2 — N (naive rewrite) vs C (conservative assimilation), per the updated spec
// (research/experiment-entity-model-coherence.md, 2026-07-15). Reuses run-1's
// fixture, prober, and deterministic scorer; scores against the audited v2 key.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROBE_CONCURRENCY, PROBE_MAX_TOKENS, PROBE_SYSTEM, probeUserPrompt, TOTAL_CYCLES } from "./config.ts";
import {
  ALL_POLICIES2,
  C_SYSTEM,
  cUserPrompt,
  MAINTAIN_MAX_TOKENS_N,
  N_SYSTEM,
  nUserPrompt,
  OPS_MAX_TOKENS_C,
  type Policy2,
} from "./run2-config.ts";
import {
  applicableKey,
  EXPERIMENT_DIR,
  loadProbes,
  loadSession,
  loadSessions,
  type Probe,
  type ProbesFile,
} from "./fixture.ts";
import { callModel, mapWithConcurrency } from "./anthropic.ts";
import { aggregateMetrics, noiseCount, salienceScore, scoreProbe } from "./scorer.ts";
import { applyOps, emptyState, render, type ModelState, type Op, type OpOutcome } from "./model.ts";
import { scanFabricatedDates } from "./datescan.ts";

const RESULTS_DIR = join(EXPERIMENT_DIR, "results-run2");
const pad = (n: number) => String(n).padStart(2, "0");

type Args = { policies: Policy2[]; cycles: number; dryRun: boolean };

function parseArgs(argv: string[]): Args {
  let policies: Policy2[] = [...ALL_POLICIES2];
  let cycles = TOTAL_CYCLES;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--policies") {
      const v = argv[++i];
      if (!v) throw new Error("--policies requires a value");
      policies = v.split(",").map((p) => p.trim()) as Policy2[];
      for (const p of policies) {
        if (!ALL_POLICIES2.includes(p)) throw new Error(`Unknown policy: ${p}`);
      }
    } else if (a === "--cycles") {
      const v = argv[++i];
      if (!v) throw new Error("--cycles requires a value");
      cycles = Number(v);
      if (!Number.isInteger(cycles) || cycles < 1 || cycles > TOTAL_CYCLES) {
        throw new Error(`--cycles must be an integer in 1..${TOTAL_CYCLES}`);
      }
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return { policies, cycles, dryRun };
}

type ProbeAnswer = {
  id: string;
  metric: string;
  question: string;
  answer: string;
  score: number;
  keyCycles: [number, number];
};
type AnswersFile = { policy: Policy2; cycle: number; date: string; probes: ProbeAnswer[] };

type ScoreRecord = {
  policy: Policy2;
  cycle: number;
  metrics: Record<string, number>;
  aux: { bytes: number; noiseCount: number; fabricatedDates: number; fabricated: string[] };
};

const p = {
  projection: (policy: Policy2, cycle: number) => join(RESULTS_DIR, "projections", policy, `cycle-${pad(cycle)}.md`),
  answers: (policy: Policy2, cycle: number) => join(RESULTS_DIR, "answers", policy, `cycle-${pad(cycle)}.json`),
  state: (cycle: number) => join(RESULTS_DIR, "state", "C", `cycle-${pad(cycle)}.json`),
  ops: (cycle: number) => join(RESULTS_DIR, "ops", "C", `cycle-${pad(cycle)}.json`),
};

// --- C maintain: one structured ops call, deterministically applied ---

function parseOps(raw: string): Op[] {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("no JSON object in output");
  const obj = JSON.parse(text.slice(start, end + 1)) as { ops?: unknown };
  if (!Array.isArray(obj.ops)) throw new Error('parsed JSON has no "ops" array');
  return obj.ops as Op[];
}

async function proposeOps(state: ModelState, cycle: number, date: string, transcript: string): Promise<Op[]> {
  const modelWithIds = render(state, true);
  const user = cUserPrompt(modelWithIds, date, transcript);
  const label = `maintain C cycle ${cycle} (ops)`;
  const first = await callModel({ system: C_SYSTEM, user, maxTokens: OPS_MAX_TOKENS_C, label });
  try {
    return parseOps(first);
  } catch (err) {
    // One corrective retry: re-issue with the parse error appended.
    const msg = err instanceof Error ? err.message : String(err);
    const retryUser = `${user}\n\nYour previous output could not be parsed as JSON (${msg}). Output ONLY the JSON object {"ops": [...]}, nothing else.`;
    const second = await callModel({ system: C_SYSTEM, user: retryUser, maxTokens: OPS_MAX_TOKENS_C, label: `${label} retry` });
    return parseOps(second);
  }
}

// --- Probe + score (identical battery for both policies; v2 key + statedDates) ---

async function probeAndScore(
  fixture: ProbesFile,
  policy: Policy2,
  cycle: number,
  date: string,
  projection: string,
): Promise<AnswersFile> {
  const applicable: { probe: Probe; keyCycles: [number, number] }[] = [];
  for (const probe of fixture.probes) {
    const key = applicableKey(probe, cycle);
    if (key) applicable.push({ probe, keyCycles: key.cycles });
  }
  const ctx = { abstainMarkers: fixture.abstainMarkers, dateRegex: fixture.dateRegex, statedDates: fixture.statedDates };

  const answered = await mapWithConcurrency(applicable, PROBE_CONCURRENCY, async ({ probe, keyCycles }) => {
    const answer = await callModel({
      system: PROBE_SYSTEM,
      user: probeUserPrompt(projection, probe.question),
      maxTokens: PROBE_MAX_TOKENS,
      label: `probe ${probe.id} ${policy} cycle ${cycle}`,
    });
    const key = applicableKey(probe, cycle)!;
    const score = scoreProbe(probe, key, answer, ctx);
    return { id: probe.id, metric: probe.metric, question: probe.question, answer, score, keyCycles } satisfies ProbeAnswer;
  });

  return { policy, cycle, date, probes: answered };
}

function computeScoreRecord(
  fixture: ProbesFile,
  sessionDates: string[],
  policy: Policy2,
  cycle: number,
  projection: string,
  answers: AnswersFile,
): ScoreRecord {
  const probeScores = new Map<string, number[]>();
  for (const a of answers.probes) {
    if (!probeScores.has(a.metric)) probeScores.set(a.metric, []);
    probeScores.get(a.metric)!.push(a.score);
  }
  const salience = salienceScore(projection, fixture.salienceElements, cycle);
  const { metrics, overall } = aggregateMetrics(probeScores, salience);
  metrics.overall = overall;
  const scan = scanFabricatedDates(projection, fixture.statedDates ?? [], sessionDates);
  return {
    policy,
    cycle,
    metrics,
    aux: {
      bytes: Buffer.byteLength(projection, "utf8"),
      noiseCount: noiseCount(projection, fixture.noiseItems),
      fabricatedDates: scan.count,
      fabricated: scan.fabricated,
    },
  };
}

// --- Summary writers ---
const METRIC_ORDER = [
  "current_fact",
  "supersession",
  "lineage",
  "confabulation",
  "relationship",
  "reunion",
  "salience",
  "overall",
];
const AUX_ORDER = ["bytes", "noiseCount", "fabricatedDates"] as const;

function writeSummaries(records: ScoreRecord[], policies: Policy2[], cycles: number) {
  writeFileSync(join(RESULTS_DIR, "scores.json"), JSON.stringify(records, null, 2) + "\n");

  const lines: string[] = ["policy,cycle,metric,value"];
  for (const r of records) {
    for (const metric of METRIC_ORDER) {
      if (metric in r.metrics) lines.push(`${r.policy},${r.cycle},${metric},${r.metrics[metric]}`);
    }
    for (const aux of AUX_ORDER) lines.push(`${r.policy},${r.cycle},${aux},${r.aux[aux]}`);
  }
  writeFileSync(join(RESULTS_DIR, "scores.csv"), lines.join("\n") + "\n");

  const byKey = new Map<string, ScoreRecord>();
  for (const r of records) byKey.set(`${r.policy}:${r.cycle}`, r);
  const fmt = (v: number | undefined) => (v === undefined ? "" : v.toFixed(3));

  const out: string[] = ["# Entity-model coherence — run 2 trajectory (N vs C, v2 key)", ""];
  for (const metric of METRIC_ORDER) {
    out.push(`## ${metric}`, "");
    out.push(`| cycle | ${policies.join(" | ")} |`);
    out.push(`| --- | ${policies.map(() => "---").join(" | ")} |`);
    for (let c = 1; c <= cycles; c++) {
      const cols = policies.map((pol) => fmt(byKey.get(`${pol}:${c}`)?.metrics[metric]));
      out.push(`| ${c} | ${cols.join(" | ")} |`);
    }
    out.push("");
  }
  for (const aux of AUX_ORDER) {
    out.push(`## ${aux} (aux)`, "");
    out.push(`| cycle | ${policies.join(" | ")} |`);
    out.push(`| --- | ${policies.map(() => "---").join(" | ")} |`);
    for (let c = 1; c <= cycles; c++) {
      const cols = policies.map((pol) => {
        const v = byKey.get(`${pol}:${c}`)?.aux[aux];
        return v === undefined ? "" : String(v);
      });
      out.push(`| ${c} | ${cols.join(" | ")} |`);
    }
    out.push("");
  }
  writeFileSync(join(RESULTS_DIR, "trajectory.md"), out.join("\n") + "\n");
}

// --- Dry run ---
function dryRun(fixture: ProbesFile, cycles: number) {
  for (const probe of fixture.probes) {
    for (const [from, to] of probe.keys.map((k) => k.cycles)) {
      if (from < 1 || to > TOTAL_CYCLES || from > to) {
        throw new Error(`Probe ${probe.id}: invalid cycle range [${from}, ${to}]`);
      }
    }
  }
  if (!fixture.statedDates || fixture.statedDates.length === 0) {
    throw new Error("v2 key has no statedDates — confabulation scoring would be wrong");
  }
  const sessions = loadSessions(cycles);

  // Exercise the C op-application path end-to-end without the API.
  const state = emptyState();
  const { outcomes } = applyOps(
    state,
    [
      { op: "add", section: "current", text: "smoke item", salience: 0.5, surprise: "none" },
      { op: "supersede", targetId: "cs-1", text: "smoke item v2", surprise: "strong" },
      { op: "note_mismatch", section: "core", note: "smoke", surprise: "mild", salience: 0.5 },
    ],
    1,
    sessions[0].date,
  );
  if (outcomes.some((o) => o.outcome === "rejected")) throw new Error("dry-run op self-check failed");
  render(state, true);
  render(state, false);

  // Fabricated-date scanner self-check.
  const scan = scanFabricatedDates(
    "She sprained her ankle on 2025-04-09. The hike was March 14. Marathon in October 2025.",
    fixture.statedDates,
    sessions.map((s) => s.date),
  );
  if (scan.count !== 1 || scan.fabricated[0] !== "2025-04-09") {
    throw new Error(`dry-run datescan self-check failed: ${JSON.stringify(scan)}`);
  }

  console.log("Per-cycle applicable probe counts:");
  for (let c = 1; c <= cycles; c++) {
    const count = fixture.probes.filter((probe) => applicableKey(probe, c) !== null).length;
    console.log(`  cycle ${pad(c)}: ${count} probe(s)`);
  }
  console.log("Dry run OK.");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fixture = loadProbes("probes-v2.json");

  if (args.dryRun) {
    dryRun(fixture, args.cycles);
    return;
  }

  mkdirSync(RESULTS_DIR, { recursive: true });
  const sessionDates = loadSessions(args.cycles).map((s) => s.date);
  const records: ScoreRecord[] = [];

  for (const policy of args.policies) {
    mkdirSync(join(RESULTS_DIR, "projections", policy), { recursive: true });
    mkdirSync(join(RESULTS_DIR, "answers", policy), { recursive: true });
    if (policy === "C") {
      mkdirSync(join(RESULTS_DIR, "state", "C"), { recursive: true });
      mkdirSync(join(RESULTS_DIR, "ops", "C"), { recursive: true });
    }

    let prevProjection: string | null = null; // N
    let state: ModelState = emptyState(); // C

    for (let cycle = 1; cycle <= args.cycles; cycle++) {
      const session = loadSession(cycle);
      const projPath = p.projection(policy, cycle);
      const ansPath = p.answers(policy, cycle);
      const resumable =
        existsSync(projPath) && existsSync(ansPath) && (policy !== "C" || existsSync(p.state(cycle)));

      let projection: string;
      let answers: AnswersFile;

      if (resumable) {
        projection = readFileSync(projPath, "utf8");
        answers = JSON.parse(readFileSync(ansPath, "utf8")) as AnswersFile;
        if (policy === "C") state = JSON.parse(readFileSync(p.state(cycle), "utf8")) as ModelState;
        console.log(`[${policy}] cycle ${pad(cycle)}: reused existing results`);
      } else if (policy === "N") {
        projection = await callModel({
          system: N_SYSTEM,
          user: nUserPrompt(prevProjection, session.date, session.transcript),
          maxTokens: MAINTAIN_MAX_TOKENS_N,
          label: `maintain N cycle ${cycle}`,
        });
        writeFileSync(projPath, projection);
        answers = await probeAndScore(fixture, policy, cycle, session.date, projection);
        writeFileSync(ansPath, JSON.stringify(answers, null, 2) + "\n");
        console.log(`[N] cycle ${pad(cycle)}: rewritten + probed (${answers.probes.length} probes)`);
      } else {
        const ops = await proposeOps(state, cycle, session.date, session.transcript);
        const applied: { outcomes: OpOutcome[] } = applyOps(state, ops, cycle, session.date);
        projection = render(state, false);
        writeFileSync(p.ops(cycle), JSON.stringify({ cycle, date: session.date, outcomes: applied.outcomes }, null, 2) + "\n");
        writeFileSync(p.state(cycle), JSON.stringify(state, null, 2) + "\n");
        writeFileSync(projPath, projection);
        answers = await probeAndScore(fixture, policy, cycle, session.date, projection);
        writeFileSync(ansPath, JSON.stringify(answers, null, 2) + "\n");
        const counts = applied.outcomes.reduce<Record<string, number>>((acc, o) => {
          acc[o.outcome] = (acc[o.outcome] ?? 0) + 1;
          return acc;
        }, {});
        console.log(
          `[C] cycle ${pad(cycle)}: ${ops.length} ops (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}) + probed (${answers.probes.length} probes)`,
        );
      }

      prevProjection = projection;
      records.push(computeScoreRecord(fixture, sessionDates, policy, cycle, projection, answers));
      writeSummaries(records, args.policies, args.cycles);
    }
  }

  console.log(`Done. ${records.length} cycle records written to ${RESULTS_DIR}`);
}

main().catch((err) => {
  console.error(`\nABORTED: ${err instanceof Error ? err.message : String(err)}`);
  console.error("Partial results (if any) remain on disk.");
  process.exit(1);
});
