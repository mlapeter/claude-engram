// Entity-model coherence experiment harness. See HARNESS-SPEC.md — it is the contract.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALL_POLICIES,
  MAINTAINER_SYSTEM,
  MAINTAIN_MAX_TOKENS,
  P2_REDERIVE_CYCLES,
  PROBE_CONCURRENCY,
  PROBE_MAX_TOKENS,
  PROBE_SYSTEM,
  patchUserPrompt,
  probeUserPrompt,
  rederiveUserPrompt,
  TOTAL_CYCLES,
  type Policy,
} from "./config.ts";
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
import {
  aggregateMetrics,
  noiseCount,
  salienceScore,
  scoreProbe,
} from "./scorer.ts";

const RESULTS_DIR = join(EXPERIMENT_DIR, "results");
const pad = (n: number) => String(n).padStart(2, "0");

type Args = { policies: Policy[]; cycles: number; dryRun: boolean };

function parseArgs(argv: string[]): Args {
  let policies: Policy[] = [...ALL_POLICIES];
  let cycles = TOTAL_CYCLES;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--policies") {
      const v = argv[++i];
      if (!v) throw new Error("--policies requires a value");
      policies = v.split(",").map((p) => p.trim()) as Policy[];
      for (const p of policies) {
        if (!ALL_POLICIES.includes(p)) throw new Error(`Unknown policy: ${p}`);
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

// --- Answers file shape ---
type ProbeAnswer = {
  id: string;
  metric: string;
  question: string;
  answer: string;
  score: number;
  keyCycles: [number, number];
};
type AnswersFile = { policy: Policy; cycle: number; date: string; probes: ProbeAnswer[] };

type ScoreRecord = {
  policy: Policy;
  cycle: number;
  metrics: Record<string, number>;
  aux: { bytes: number; noiseCount: number };
};

function ensureDir(p: string) {
  mkdirSync(p, { recursive: true });
}

function projectionPath(policy: Policy, cycle: number) {
  return join(RESULTS_DIR, "projections", policy, `cycle-${pad(cycle)}.md`);
}
function answersPath(policy: Policy, cycle: number) {
  return join(RESULTS_DIR, "answers", policy, `cycle-${pad(cycle)}.json`);
}

// --- Maintain: produce the projection for (policy, cycle) via one model call ---
async function maintain(
  policy: Policy,
  cycle: number,
  prevProjection: string | null,
): Promise<string> {
  const isRederive = policy === "P1" || (policy === "P2" && P2_REDERIVE_CYCLES.has(cycle));
  if (isRederive) {
    const sessions = loadSessions(cycle);
    const lastDate = sessions[sessions.length - 1].date;
    const user = rederiveUserPrompt(sessions, lastDate);
    return callModel({
      system: MAINTAINER_SYSTEM,
      user,
      maxTokens: MAINTAIN_MAX_TOKENS,
      label: `maintain ${policy} cycle ${cycle} (rederive)`,
    });
  }
  const session = loadSession(cycle);
  const user = patchUserPrompt(prevProjection, session.date, session.transcript);
  return callModel({
    system: MAINTAINER_SYSTEM,
    user,
    maxTokens: MAINTAIN_MAX_TOKENS,
    label: `maintain ${policy} cycle ${cycle} (patch)`,
  });
}

// --- Probe + score all applicable probes for a cycle ---
async function probeAndScore(
  fixture: ProbesFile,
  policy: Policy,
  cycle: number,
  date: string,
  projection: string,
): Promise<AnswersFile> {
  const applicable: { probe: Probe; keyCycles: [number, number] }[] = [];
  for (const probe of fixture.probes) {
    const key = applicableKey(probe, cycle);
    if (key) applicable.push({ probe, keyCycles: key.cycles });
  }

  const answered = await mapWithConcurrency(
    applicable,
    PROBE_CONCURRENCY,
    async ({ probe, keyCycles }) => {
      const answer = await callModel({
        system: PROBE_SYSTEM,
        user: probeUserPrompt(projection, probe.question),
        maxTokens: PROBE_MAX_TOKENS,
        label: `probe ${probe.id} ${policy} cycle ${cycle}`,
      });
      const key = applicableKey(probe, cycle)!;
      const score = scoreProbe(probe, key, answer, {
        abstainMarkers: fixture.abstainMarkers,
        dateRegex: fixture.dateRegex,
      });
      const rec: ProbeAnswer = {
        id: probe.id,
        metric: probe.metric,
        question: probe.question,
        answer,
        score,
        keyCycles,
      };
      return rec;
    },
  );

  return { policy, cycle, date, probes: answered };
}

// Deterministically compute the ScoreRecord from a projection + answers.
function computeScoreRecord(
  fixture: ProbesFile,
  policy: Policy,
  cycle: number,
  projection: string,
  answers: AnswersFile,
): ScoreRecord {
  const probeScores = new Map<string, number[]>();
  for (const p of answers.probes) {
    if (!probeScores.has(p.metric)) probeScores.set(p.metric, []);
    probeScores.get(p.metric)!.push(p.score);
  }
  const salience = salienceScore(projection, fixture.salienceElements, cycle);
  const { metrics, overall } = aggregateMetrics(probeScores, salience);
  metrics.overall = overall;
  return {
    policy,
    cycle,
    metrics,
    aux: {
      bytes: Buffer.byteLength(projection, "utf8"),
      noiseCount: noiseCount(projection, fixture.noiseItems),
    },
  };
}

// --- Summary writers (rewritten incrementally after every cycle) ---
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

function writeSummaries(records: ScoreRecord[], policies: Policy[], cycles: number) {
  // scores.json
  writeFileSync(join(RESULTS_DIR, "scores.json"), JSON.stringify(records, null, 2) + "\n");

  // scores.csv — flat metric rows + aux rows
  const lines: string[] = ["policy,cycle,metric,value"];
  for (const r of records) {
    for (const metric of METRIC_ORDER) {
      if (metric in r.metrics) lines.push(`${r.policy},${r.cycle},${metric},${r.metrics[metric]}`);
    }
    lines.push(`${r.policy},${r.cycle},bytes,${r.aux.bytes}`);
    lines.push(`${r.policy},${r.cycle},noiseCount,${r.aux.noiseCount}`);
  }
  writeFileSync(join(RESULTS_DIR, "scores.csv"), lines.join("\n") + "\n");

  // trajectory.md — one table per metric (rows = cycle, cols = policies)
  const byKey = new Map<string, ScoreRecord>();
  for (const r of records) byKey.set(`${r.policy}:${r.cycle}`, r);
  const fmt = (v: number | undefined) => (v === undefined ? "" : v.toFixed(3));

  const out: string[] = ["# Entity-model coherence — trajectory", ""];
  for (const metric of METRIC_ORDER) {
    out.push(`## ${metric}`, "");
    out.push(`| cycle | ${policies.join(" | ")} |`);
    out.push(`| --- | ${policies.map(() => "---").join(" | ")} |`);
    for (let c = 1; c <= cycles; c++) {
      const cols = policies.map((p) => fmt(byKey.get(`${p}:${c}`)?.metrics[metric]));
      out.push(`| ${c} | ${cols.join(" | ")} |`);
    }
    out.push("");
  }
  writeFileSync(join(RESULTS_DIR, "trajectory.md"), out.join("\n") + "\n");
}

// --- Dry run: validate fixtures, key ranges, scorer; print per-cycle probe counts ---
function dryRun(fixture: ProbesFile, cycles: number) {
  // Validate probe key cycle ranges: within 1..12, sane, non-overlapping per probe.
  for (const probe of fixture.probes) {
    const ranges = probe.keys.map((k) => k.cycles);
    for (const [from, to] of ranges) {
      if (from < 1 || to > TOTAL_CYCLES || from > to) {
        throw new Error(
          `Probe ${probe.id}: invalid cycle range [${from}, ${to}] (must be within 1..${TOTAL_CYCLES}, from<=to).`,
        );
      }
    }
    const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i][0] <= sorted[i - 1][1]) {
        throw new Error(
          `Probe ${probe.id}: overlapping key ranges [${sorted[i - 1]}] and [${sorted[i]}].`,
        );
      }
    }
  }

  // Sessions must all load (parses dates).
  loadSessions(cycles);

  // Exercise the scorer against stub answers (perfect / stale / partial / abstain / confab).
  runScorerSelfCheck(fixture);

  // Per-cycle probe counts.
  console.log("Per-cycle applicable probe counts:");
  for (let c = 1; c <= cycles; c++) {
    const count = fixture.probes.filter((p) => applicableKey(p, c) !== null).length;
    console.log(`  cycle ${pad(c)}: ${count} probe(s)`);
  }
  console.log("Dry run OK.");
}

// A minimal in-process sanity check of the scorer against hand-made answers.
function runScorerSelfCheck(fixture: ProbesFile) {
  const ctx = { abstainMarkers: fixture.abstainMarkers, dateRegex: fixture.dateRegex };
  const byId = (id: string) => {
    const p = fixture.probes.find((x) => x.id === id);
    if (!p) throw new Error(`self-check: probe ${id} not found`);
    return p;
  };

  // Regular probe: mustNotContain hit → 0
  const training = byId("cf-training");
  const staleKey = applicableKey(training, 8)!; // [7,9]
  const staleScore = scoreProbe(
    training,
    staleKey,
    "She is still training, the training is going well.",
    ctx,
  );
  if (staleScore !== 0) throw new Error(`self-check: expected stale→0, got ${staleScore}`);

  // Abstain probe, confabulated date → 0
  const marDate = byId("conf-marathon-date");
  const confKey = applicableKey(marDate, 5)!;
  const confScore = scoreProbe(marDate, confKey, "It is on October 5.", ctx);
  if (confScore !== 0) throw new Error(`self-check: expected confab date→0, got ${confScore}`);

  // Abstain probe, proper abstention → 1
  const abstainScore = scoreProbe(
    marDate,
    confKey,
    "That is not stated in the entity model.",
    ctx,
  );
  if (abstainScore !== 1) throw new Error(`self-check: expected abstain→1, got ${abstainScore}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fixture = loadProbes();

  if (args.dryRun) {
    dryRun(fixture, args.cycles);
    return;
  }

  ensureDir(RESULTS_DIR);
  const records: ScoreRecord[] = [];

  for (const policy of args.policies) {
    ensureDir(join(RESULTS_DIR, "projections", policy));
    ensureDir(join(RESULTS_DIR, "answers", policy));
    let prevProjection: string | null = null;

    for (let cycle = 1; cycle <= args.cycles; cycle++) {
      const projPath = projectionPath(policy, cycle);
      const ansPath = answersPath(policy, cycle);
      const date = loadSession(cycle).date;

      let projection: string;
      let answers: AnswersFile;

      if (existsSync(projPath) && existsSync(ansPath)) {
        // Idempotent resume: reuse both artifacts.
        projection = readFileSync(projPath, "utf8");
        answers = JSON.parse(readFileSync(ansPath, "utf8")) as AnswersFile;
        console.log(`[${policy}] cycle ${pad(cycle)}: reused existing results`);
      } else {
        projection = await maintain(policy, cycle, prevProjection);
        writeFileSync(projPath, projection);
        answers = await probeAndScore(fixture, policy, cycle, date, projection);
        writeFileSync(ansPath, JSON.stringify(answers, null, 2) + "\n");
        console.log(
          `[${policy}] cycle ${pad(cycle)}: maintained + probed (${answers.probes.length} probes)`,
        );
      }

      prevProjection = projection;
      records.push(computeScoreRecord(fixture, policy, cycle, projection, answers));
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
