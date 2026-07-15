// Run 3 — C (conservative assimilation + ops-gated hygiene) vs N (naive rewrite), 24 cycles,
// per run3-trait-arc-spec.md. Gates Phase 2 of the Bansai build. Reuses run 1/2's fixture,
// prober, deterministic scorer, and the C op-engine; scores against the pre-registered v4 key.
// Adds: accommodation threshold 3.0 (reported raw), ops-gated compaction at cycles 8/16/24 with
// auto-pin, and a per-cycle ledger trajectory.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROBE_CONCURRENCY, PROBE_MAX_TOKENS, PROBE_SYSTEM, probeUserPrompt } from "./config.ts";
import {
  ALL_POLICIES3,
  ACCOMMODATE_THRESHOLD_RUN3,
  C_SYSTEM,
  cUserPrompt,
  HYGIENE_CYCLES,
  MAINTAIN_MAX_TOKENS_N,
  N_SYSTEM,
  nUserPrompt,
  OPS_MAX_TOKENS_C,
  TOTAL_CYCLES_RUN3,
  type Policy3,
} from "./run3-config.ts";
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
import {
  applyOps,
  emptyState,
  ledgerSnapshot,
  render,
  type LedgerSnapshotRow,
  type ModelState,
  type Op,
  type OpOutcome,
} from "./model.ts";
import {
  applyHygieneOps,
  computePinnedIds,
  HYGIENE_MAX_TOKENS,
  HYGIENE_SYSTEM,
  hygieneUserPrompt,
  type HygieneOp,
  type HygieneOutcome,
} from "./hygiene.ts";
import { scanFabricatedDates } from "./datescan.ts";

const RESULTS_DIR = join(EXPERIMENT_DIR, "results-run3");
const pad = (n: number) => String(n).padStart(2, "0");

type Args = { policies: Policy3[]; cycles: number; dryRun: boolean };

function parseArgs(argv: string[]): Args {
  let policies: Policy3[] = [...ALL_POLICIES3];
  let cycles = TOTAL_CYCLES_RUN3;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--policies") {
      const v = argv[++i];
      if (!v) throw new Error("--policies requires a value");
      policies = v.split(",").map((p) => p.trim()) as Policy3[];
      for (const p of policies) if (!ALL_POLICIES3.includes(p)) throw new Error(`Unknown policy: ${p}`);
    } else if (a === "--cycles") {
      const v = argv[++i];
      if (!v) throw new Error("--cycles requires a value");
      cycles = Number(v);
      if (!Number.isInteger(cycles) || cycles < 1 || cycles > TOTAL_CYCLES_RUN3) {
        throw new Error(`--cycles must be an integer in 1..${TOTAL_CYCLES_RUN3}`);
      }
    } else throw new Error(`Unknown argument: ${a}`);
  }
  return { policies, cycles, dryRun };
}

type ProbeAnswer = {
  id: string; metric: string; question: string; answer: string; score: number; keyCycles: [number, number];
};
type AnswersFile = { policy: Policy3; cycle: number; date: string; probes: ProbeAnswer[] };

type ScoreRecord = {
  policy: Policy3; cycle: number; metrics: Record<string, number>;
  aux: { bytes: number; noiseCount: number; fabricatedDates: number; fabricated: string[] };
};

// Per-cycle ledger + accommodation instrumentation (C only).
type LedgerCycle = {
  cycle: number; date: string; threshold: number;
  snapshot: LedgerSnapshotRow[];
  accommodatedThisCycle: { targetId: string; detail: string }[];
  hygieneRan: boolean;
};

const p = {
  projection: (policy: Policy3, cycle: number) => join(RESULTS_DIR, "projections", policy, `cycle-${pad(cycle)}.md`),
  answers: (policy: Policy3, cycle: number) => join(RESULTS_DIR, "answers", policy, `cycle-${pad(cycle)}.json`),
  state: (cycle: number) => join(RESULTS_DIR, "state", "C", `cycle-${pad(cycle)}.json`),
  ops: (cycle: number) => join(RESULTS_DIR, "ops", "C", `cycle-${pad(cycle)}.json`),
  hygiene: (cycle: number) => join(RESULTS_DIR, "hygiene", "C", `cycle-${pad(cycle)}.json`),
  ledger: (cycle: number) => join(RESULTS_DIR, "ledger", "C", `cycle-${pad(cycle)}.json`),
};

function parseOpsObject(raw: string): unknown[] {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("no JSON object in output");
  const obj = JSON.parse(text.slice(start, end + 1)) as { ops?: unknown };
  if (!Array.isArray(obj.ops)) throw new Error('parsed JSON has no "ops" array');
  return obj.ops as unknown[];
}

async function proposeOps(state: ModelState, cycle: number, date: string, transcript: string): Promise<Op[]> {
  const user = cUserPrompt(render(state, true), date, transcript);
  const label = `maintain C cycle ${cycle} (ops)`;
  const first = await callModel({ system: C_SYSTEM, user, maxTokens: OPS_MAX_TOKENS_C, label });
  try {
    return parseOpsObject(first) as Op[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const retryUser = `${user}\n\nYour previous output could not be parsed as JSON (${msg}). Output ONLY the JSON object {"ops": [...]}, nothing else.`;
    const second = await callModel({ system: C_SYSTEM, user: retryUser, maxTokens: OPS_MAX_TOKENS_C, label: `${label} retry` });
    return parseOpsObject(second) as Op[];
  }
}

async function proposeHygieneOps(state: ModelState, cycle: number, date: string): Promise<HygieneOp[]> {
  const user = hygieneUserPrompt(render(state, true), date);
  const label = `hygiene C cycle ${cycle}`;
  const first = await callModel({ system: HYGIENE_SYSTEM, user, maxTokens: HYGIENE_MAX_TOKENS, label });
  try {
    return parseOpsObject(first) as HygieneOp[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const retryUser = `${user}\n\nYour previous output could not be parsed as JSON (${msg}). Output ONLY the JSON object {"ops": [...]}, nothing else.`;
    const second = await callModel({ system: HYGIENE_SYSTEM, user: retryUser, maxTokens: HYGIENE_MAX_TOKENS, label: `${label} retry` });
    return parseOpsObject(second) as HygieneOp[];
  }
}

async function probeAndScore(
  fixture: ProbesFile, policy: Policy3, cycle: number, date: string, projection: string,
): Promise<AnswersFile> {
  const applicable: { probe: Probe; keyCycles: [number, number] }[] = [];
  for (const probe of fixture.probes) {
    const key = applicableKey(probe, cycle);
    if (key) applicable.push({ probe, keyCycles: key.cycles });
  }
  const ctx = { abstainMarkers: fixture.abstainMarkers, dateRegex: fixture.dateRegex, statedDates: fixture.statedDates };
  const answered = await mapWithConcurrency(applicable, PROBE_CONCURRENCY, async ({ probe, keyCycles }) => {
    const answer = await callModel({
      system: PROBE_SYSTEM, user: probeUserPrompt(projection, probe.question),
      maxTokens: PROBE_MAX_TOKENS, label: `probe ${probe.id} ${policy} cycle ${cycle}`,
    });
    const key = applicableKey(probe, cycle)!;
    const score = scoreProbe(probe, key, answer, ctx);
    return { id: probe.id, metric: probe.metric, question: probe.question, answer, score, keyCycles } satisfies ProbeAnswer;
  });
  return { policy, cycle, date, probes: answered };
}

function computeScoreRecord(
  fixture: ProbesFile, sessionDates: string[], policy: Policy3, cycle: number, projection: string, answers: AnswersFile,
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
    policy, cycle, metrics,
    aux: { bytes: Buffer.byteLength(projection, "utf8"), noiseCount: noiseCount(projection, fixture.noiseItems), fabricatedDates: scan.count, fabricated: scan.fabricated },
  };
}

const METRIC_ORDER = ["current_fact", "supersession", "lineage", "confabulation", "relationship", "reunion", "trait", "salience", "overall"];
const AUX_ORDER = ["bytes", "noiseCount", "fabricatedDates"] as const;

function writeSummaries(records: ScoreRecord[], policies: Policy3[], cycles: number) {
  writeFileSync(join(RESULTS_DIR, "scores.json"), JSON.stringify(records, null, 2) + "\n");
  const lines: string[] = ["policy,cycle,metric,value"];
  for (const r of records) {
    for (const metric of METRIC_ORDER) if (metric in r.metrics) lines.push(`${r.policy},${r.cycle},${metric},${r.metrics[metric]}`);
    for (const aux of AUX_ORDER) lines.push(`${r.policy},${r.cycle},${aux},${r.aux[aux]}`);
  }
  writeFileSync(join(RESULTS_DIR, "scores.csv"), lines.join("\n") + "\n");

  const byKey = new Map<string, ScoreRecord>();
  for (const r of records) byKey.set(`${r.policy}:${r.cycle}`, r);
  const fmt = (v: number | undefined) => (v === undefined ? "" : v.toFixed(3));
  const out: string[] = ["# Entity-model coherence — run 3 trajectory (N vs C+hygiene, v4 key, threshold 3.0)", ""];
  for (const metric of METRIC_ORDER) {
    out.push(`## ${metric}`, "", `| cycle | ${policies.join(" | ")} |`, `| --- | ${policies.map(() => "---").join(" | ")} |`);
    for (let c = 1; c <= cycles; c++) out.push(`| ${c} | ${policies.map((pol) => fmt(byKey.get(`${pol}:${c}`)?.metrics[metric])).join(" | ")} |`);
    out.push("");
  }
  for (const aux of AUX_ORDER) {
    out.push(`## ${aux} (aux)`, "", `| cycle | ${policies.join(" | ")} |`, `| --- | ${policies.map(() => "---").join(" | ")} |`);
    for (let c = 1; c <= cycles; c++) {
      out.push(`| ${c} | ${policies.map((pol) => { const v = byKey.get(`${pol}:${c}`)?.aux[aux]; return v === undefined ? "" : String(v); }).join(" | ")} |`);
    }
    out.push("");
  }
  writeFileSync(join(RESULTS_DIR, "trajectory.md"), out.join("\n") + "\n");
}

// Ledger trajectory: cycle × bucket cumulative total, with the threshold line.
function writeLedgerTrajectory(ledgerCycles: LedgerCycle[], threshold: number) {
  writeFileSync(join(RESULTS_DIR, "ledger-trajectory.json"), JSON.stringify(ledgerCycles, null, 2) + "\n");
  const keys = new Set<string>();
  for (const lc of ledgerCycles) for (const row of lc.snapshot) keys.add(row.key);
  const keyList = [...keys];
  const label = (k: string) => {
    for (const lc of ledgerCycles) {
      const row = lc.snapshot.find((r) => r.key === k);
      if (row?.targetText) return `${k} [${row.targetSection}] ${row.targetText.slice(0, 40)}`;
    }
    return k;
  };
  const out: string[] = [
    `# Ledger trajectory — run 3 (C), accommodation threshold = ${threshold.toFixed(1)}`, "",
    "Cumulative ledger total per bucket per cycle (the accommodation half of the surprise ledger).",
    "A bucket resets to 0 the cycle it ACCOMMODATES (crosses threshold → item superseded).", "",
    "## Bucket legend", "",
  ];
  for (const k of keyList) out.push(`- \`${k}\` — ${label(k)}`);
  out.push("", "## Cumulative total by cycle", "", `| cycle | hygiene | ${keyList.map((k) => `\`${k}\``).join(" | ")} | accommodated |`, `| --- | --- | ${keyList.map(() => "---").join(" | ")} | --- |`);
  for (const lc of ledgerCycles) {
    const cells = keyList.map((k) => {
      const row = lc.snapshot.find((r) => r.key === k);
      return row ? row.total.toFixed(3) : "";
    });
    const acc = lc.accommodatedThisCycle.map((a) => a.targetId).join(",") || "";
    out.push(`| ${lc.cycle} | ${lc.hygieneRan ? "Y" : ""} | ${cells.join(" | ")} | ${acc} |`);
  }
  out.push("", `Threshold line: **${threshold.toFixed(1)}** — a bucket accommodates the cycle its total first reaches it.`, "");
  writeFileSync(join(RESULTS_DIR, "ledger-trajectory.md"), out.join("\n") + "\n");
}

function dryRun(fixture: ProbesFile, cycles: number) {
  for (const probe of fixture.probes) {
    for (const [from, to] of probe.keys.map((k) => k.cycles)) {
      if (from < 1 || to > TOTAL_CYCLES_RUN3 || from > to) throw new Error(`Probe ${probe.id}: invalid cycle range [${from}, ${to}]`);
    }
  }
  if (!fixture.statedDates || fixture.statedDates.length === 0) throw new Error("v4 key has no statedDates");
  const sessions = loadSessions(cycles);

  // Exercise the C op path (threshold 3.0) end-to-end.
  const state = emptyState();
  const r1 = applyOps(state, [
    { op: "add", section: "belief", text: "career central", salience: 0.6, surprise: "none", confidence: "medium" },
    { op: "add", section: "protected", text: "tender verbatim", salience: 0.9, surprise: "low" },
    { op: "add", section: "current", text: "jog 30 min", salience: 0.3, surprise: "none" },
    { op: "add", section: "current", text: "jog 40 min", salience: 0.3, surprise: "none" },
    { op: "supersede", targetId: "bel-1", text: "career reframed", salience: 0.8, surprise: "strong" },
  ], 1, sessions[0].date, ACCOMMODATE_THRESHOLD_RUN3);
  if (r1.outcomes.some((o) => o.outcome === "rejected")) throw new Error("dry-run C op self-check failed");
  // bel-1 must DEFER (strong×0.8×medium = 0.6 < 3.0), not accommodate.
  if (!r1.outcomes.some((o) => o.op.op === "supersede" && o.outcome === "deferred")) {
    throw new Error("dry-run: expected belief supersede to DEFER under threshold 3.0");
  }

  // Hygiene engine self-check: the auto-pin / sacred-verbatim / no-re-derivation guards must REFUSE.
  const pinned = computePinnedIds(state); // protected(sal-2) + open-ledger target(bel-1)
  if (!pinned.has("sal-2") || !pinned.has("bel-1")) throw new Error(`dry-run: pin set wrong: ${[...pinned]}`);
  const h = applyHygieneOps(state, [
    { op: "demote", targetId: "bel-1", reason: "looks low-confidence" }, // MUST reject (open-ledger)
    { op: "prose.compress", targetId: "sal-2", text: "tender" }, // MUST reject (protected)
    { op: "gist.merge", targetIds: ["cs-3", "cs-4"], text: "jogging 30->40 min" }, // MUST apply (unpinned current)
    { op: "supersede", targetId: "cs-3", text: "re-judged" } as unknown as HygieneOp, // MUST reject (not a compaction op)
  ], sessions[0].date, pinned);
  const byIdx = h.outcomes;
  if (byIdx[0].outcome !== "rejected") throw new Error("dry-run: demote of open-ledger belief was not rejected");
  if (byIdx[1].outcome !== "rejected") throw new Error("dry-run: prose.compress of protected was not rejected");
  if (byIdx[2].outcome !== "applied") throw new Error("dry-run: gist.merge of unpinned current items failed");
  if (byIdx[3].outcome !== "rejected") throw new Error("dry-run: re-derivation (supersede) in hygiene was not rejected");

  console.log("Per-cycle applicable probe counts:");
  for (let c = 1; c <= cycles; c++) {
    const count = fixture.probes.filter((probe) => applicableKey(probe, c) !== null).length;
    console.log(`  cycle ${pad(c)}: ${count} probe(s)${HYGIENE_CYCLES.has(c) ? "  [hygiene]" : ""}`);
  }
  console.log("Dry run OK (C threshold 3.0; auto-pin, sacred-verbatim, no-re-derivation guards all refused correctly).");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fixture = loadProbes("probes-v4.json");
  if (args.dryRun) { dryRun(fixture, args.cycles); return; }

  mkdirSync(RESULTS_DIR, { recursive: true });
  const sessionDates = loadSessions(args.cycles).map((s) => s.date);
  const records: ScoreRecord[] = [];
  const ledgerCycles: LedgerCycle[] = [];

  for (const policy of args.policies) {
    mkdirSync(join(RESULTS_DIR, "projections", policy), { recursive: true });
    mkdirSync(join(RESULTS_DIR, "answers", policy), { recursive: true });
    if (policy === "C") for (const d of ["state", "ops", "hygiene", "ledger"]) mkdirSync(join(RESULTS_DIR, d, "C"), { recursive: true });

    let prevProjection: string | null = null; // N
    let state: ModelState = emptyState(); // C

    for (let cycle = 1; cycle <= args.cycles; cycle++) {
      const session = loadSession(cycle);
      const projPath = p.projection(policy, cycle);
      const ansPath = p.answers(policy, cycle);
      const resumable = existsSync(projPath) && existsSync(ansPath) && (policy !== "C" || existsSync(p.state(cycle)));
      let projection: string;
      let answers: AnswersFile;

      if (resumable) {
        projection = readFileSync(projPath, "utf8");
        answers = JSON.parse(readFileSync(ansPath, "utf8")) as AnswersFile;
        if (policy === "C") {
          state = JSON.parse(readFileSync(p.state(cycle), "utf8")) as ModelState;
          if (existsSync(p.ledger(cycle))) ledgerCycles.push(JSON.parse(readFileSync(p.ledger(cycle), "utf8")) as LedgerCycle);
        }
        console.log(`[${policy}] cycle ${pad(cycle)}: reused existing results`);
      } else if (policy === "N") {
        projection = await callModel({ system: N_SYSTEM, user: nUserPrompt(prevProjection, session.date, session.transcript), maxTokens: MAINTAIN_MAX_TOKENS_N, label: `maintain N cycle ${cycle}` });
        writeFileSync(projPath, projection);
        answers = await probeAndScore(fixture, policy, cycle, session.date, projection);
        writeFileSync(ansPath, JSON.stringify(answers, null, 2) + "\n");
        console.log(`[N] cycle ${pad(cycle)}: rewritten + probed (${answers.probes.length} probes)`);
      } else {
        // C: assimilate (threshold 3.0), then ops-gated hygiene on hygiene cycles.
        const ops = await proposeOps(state, cycle, session.date, session.transcript);
        const applied: { outcomes: OpOutcome[] } = applyOps(state, ops, cycle, session.date, ACCOMMODATE_THRESHOLD_RUN3);
        const accommodatedThisCycle = applied.outcomes
          .filter((o) => o.outcome === "accommodated")
          .map((o) => ({ targetId: (o.op as { targetId?: string }).targetId ?? "?", detail: o.detail }));
        writeFileSync(p.ops(cycle), JSON.stringify({ cycle, date: session.date, threshold: ACCOMMODATE_THRESHOLD_RUN3, outcomes: applied.outcomes }, null, 2) + "\n");

        let hygieneRan = false;
        let hygieneOutcomes: HygieneOutcome[] = [];
        let pinnedList: string[] = [];
        if (HYGIENE_CYCLES.has(cycle)) {
          hygieneRan = true;
          const pinned = computePinnedIds(state);
          pinnedList = [...pinned];
          const hOps = await proposeHygieneOps(state, cycle, session.date);
          const hApplied = applyHygieneOps(state, hOps, session.date, pinned);
          hygieneOutcomes = hApplied.outcomes;
          writeFileSync(p.hygiene(cycle), JSON.stringify({ cycle, date: session.date, pinned: pinnedList, proposed: hOps.length, outcomes: hygieneOutcomes }, null, 2) + "\n");
        }

        projection = render(state, false);
        writeFileSync(p.state(cycle), JSON.stringify(state, null, 2) + "\n");
        writeFileSync(projPath, projection);

        const lc: LedgerCycle = { cycle, date: session.date, threshold: ACCOMMODATE_THRESHOLD_RUN3, snapshot: ledgerSnapshot(state), accommodatedThisCycle, hygieneRan };
        writeFileSync(p.ledger(cycle), JSON.stringify(lc, null, 2) + "\n");
        ledgerCycles.push(lc);

        answers = await probeAndScore(fixture, policy, cycle, session.date, projection);
        writeFileSync(ansPath, JSON.stringify(answers, null, 2) + "\n");
        const counts = applied.outcomes.reduce<Record<string, number>>((acc, o) => { acc[o.outcome] = (acc[o.outcome] ?? 0) + 1; return acc; }, {});
        const hSummary = hygieneRan ? `; hygiene ${hygieneOutcomes.filter((o) => o.outcome === "applied").length} applied / ${hygieneOutcomes.filter((o) => o.outcome === "rejected").length} rejected (pinned: ${pinnedList.length})` : "";
        const accSummary = accommodatedThisCycle.length ? `; ACCOMMODATED ${accommodatedThisCycle.map((a) => a.targetId).join(",")}` : "";
        console.log(`[C] cycle ${pad(cycle)}: ${ops.length} ops (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")})${accSummary}${hSummary} + probed (${answers.probes.length})`);
      }

      prevProjection = projection;
      records.push(computeScoreRecord(fixture, sessionDates, policy, cycle, projection, answers));
      writeSummaries(records, args.policies, args.cycles);
      if (policy === "C") writeLedgerTrajectory(ledgerCycles, ACCOMMODATE_THRESHOLD_RUN3);
    }
  }
  console.log(`Done. ${records.length} cycle records written to ${RESULTS_DIR}`);
}

main().catch((err) => {
  console.error(`\nABORTED: ${err instanceof Error ? err.message : String(err)}`);
  console.error("Partial results (if any) remain on disk.");
  process.exit(1);
});
