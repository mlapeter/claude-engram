// Run 3c — accommodation VALIDATION GATE: C (conservative assimilation + ops-gated hygiene),
// C-only, 24 cycles, at run-3b's retuned threshold (0.8) PLUS the four structural rules from
// the accommodation-iteration spec (protected-exclusion, deterministic belief-minting, per-event
// cap, distinct-occasions). Structurally identical to run3b.ts; the differences: the four rules
// are wired via ACCOMMODATION_OPTIONS into applyOps, the C prompt flags identity claims + targets
// beliefs (C_SYSTEM_RUN3C), and the ledger trajectory reports minted/rerouted/refused + occasions.
// Scores at write time against the pre-registered v4 key; canonical numbers are the v5 rescore
// (src/rescore3c.ts). Writes to results-run3c/ (run 3b's results-run3b/ untouched).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROBE_CONCURRENCY, PROBE_SYSTEM, probeUserPrompt } from "./config.ts";
import {
  ALL_POLICIES3C,
  ACCOMMODATE_THRESHOLD_RUN3C,
  ACCOMMODATION_MAX_TOKENS,
  ACCOMMODATION_OPTIONS,
  ACCOMMODATION_SYSTEM_RUN3C,
  accommodationUserPrompt,
  C_SYSTEM_RUN3C,
  cUserPrompt,
  DEFAULT_POLICIES_RUN3C,
  HYGIENE_CYCLES,
  MAINTAIN_MAX_TOKENS_N,
  MIN_DISTINCT_SESSIONS,
  N_SYSTEM,
  nUserPrompt,
  OPS_MAX_TOKENS_C,
  PER_EVENT_CAP_FRACTION,
  PROBE_MAX_TOKENS_RUN3C,
  TOTAL_CYCLES_RUN3C,
  type Policy3C,
} from "./run3c-config.ts";
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
  distinctSessions,
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

const RESULTS_DIR = join(EXPERIMENT_DIR, "results-run3c");
const pad = (n: number) => String(n).padStart(2, "0");

type Args = { policies: Policy3C[]; cycles: number; dryRun: boolean };

function parseArgs(argv: string[]): Args {
  let policies: Policy3C[] = [...DEFAULT_POLICIES_RUN3C];
  let cycles = TOTAL_CYCLES_RUN3C;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--policies") {
      const v = argv[++i];
      if (!v) throw new Error("--policies requires a value");
      policies = v.split(",").map((p) => p.trim()) as Policy3C[];
      for (const p of policies) if (!ALL_POLICIES3C.includes(p)) throw new Error(`Unknown policy: ${p}`);
    } else if (a === "--cycles") {
      const v = argv[++i];
      if (!v) throw new Error("--cycles requires a value");
      cycles = Number(v);
      if (!Number.isInteger(cycles) || cycles < 1 || cycles > TOTAL_CYCLES_RUN3C) {
        throw new Error(`--cycles must be an integer in 1..${TOTAL_CYCLES_RUN3C}`);
      }
    } else throw new Error(`Unknown argument: ${a}`);
  }
  return { policies, cycles, dryRun };
}

type ProbeAnswer = {
  id: string; metric: string; question: string; answer: string; score: number; keyCycles: [number, number];
};
type AnswersFile = { policy: Policy3C; cycle: number; date: string; probes: ProbeAnswer[] };

type ScoreRecord = {
  policy: Policy3C; cycle: number; metrics: Record<string, number>;
  aux: { bytes: number; noiseCount: number; fabricatedDates: number; fabricated: string[] };
};

// Per-cycle ledger + accommodation instrumentation (C only). Tracks the four-rule outcomes.
type LedgerCycle = {
  cycle: number; date: string; threshold: number;
  snapshot: LedgerSnapshotRow[];
  accommodatedThisCycle: { targetId: string; detail: string }[];
  mintedThisCycle: { detail: string }[];
  reroutedThisCycle: { detail: string }[];
  refusedThisCycle: { detail: string }[];
  hygieneRan: boolean;
};

const p = {
  projection: (policy: Policy3C, cycle: number) => join(RESULTS_DIR, "projections", policy, `cycle-${pad(cycle)}.md`),
  answers: (policy: Policy3C, cycle: number) => join(RESULTS_DIR, "answers", policy, `cycle-${pad(cycle)}.json`),
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
  const first = await callModel({ system: C_SYSTEM_RUN3C, user, maxTokens: OPS_MAX_TOKENS_C, label });
  try {
    return parseOpsObject(first) as Op[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const retryUser = `${user}\n\nYour previous output could not be parsed as JSON (${msg}). Output ONLY the JSON object {"ops": [...]}, nothing else.`;
    const second = await callModel({ system: C_SYSTEM_RUN3C, user: retryUser, maxTokens: OPS_MAX_TOKENS_C, label: `${label} retry` });
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

// Rule 4, completed — the ENGINE-INITIATED accommodation invite. After a cycle's ops, any
// active BELIEF whose ledger crossed the threshold AND spans ≥ MIN_DISTINCT_SESSIONS is invited
// to revise: the engine calls the model for a minimal revision and supersedes the belief with it
// (lineage kept). This is the design's "the engine, not the maintainer, decides the rewrite" —
// so a conservative maintainer that only note_mismatches (never supersedes) cannot starve a
// genuine, well-evidenced identity change. Decoys are relationship/current items, never beliefs,
// so they are structurally out of scope here (belongs-to-beliefs is the gate).
async function accommodatePass(state: ModelState, cycle: number, date: string): Promise<{ targetId: string; detail: string }[]> {
  const fired: { targetId: string; detail: string }[] = [];
  // Snapshot the belief ids up front — superseding mutates state.items during the loop.
  const candidates = state.items.filter((i) => i.section === "belief" && i.status === "active" && !!state.ledger[i.id]);
  for (const bel of candidates) {
    const bucket = state.ledger[bel.id];
    if (!bucket || bucket.total < ACCOMMODATE_THRESHOLD_RUN3C) continue;
    const occ = distinctSessions(bucket);
    if (occ < MIN_DISTINCT_SESSIONS) continue;
    const evidence = bucket.entries.map((e) => e.note).filter((n): n is string => !!n && n.trim().length > 0);
    const raw = await callModel({
      system: ACCOMMODATION_SYSTEM_RUN3C,
      user: accommodationUserPrompt(bel.text, evidence, occ),
      maxTokens: ACCOMMODATION_MAX_TOKENS,
      label: `accommodate ${bel.id} cycle ${cycle}`,
    });
    let revised = "";
    try {
      const t = raw.trim();
      const start = t.indexOf("{");
      const end = t.lastIndexOf("}");
      if (start >= 0 && end > start) revised = (JSON.parse(t.slice(start, end + 1)) as { statement?: string }).statement?.trim() ?? "";
    } catch {
      revised = "";
    }
    if (!revised) continue;
    // A supersede on a bucket already past threshold + occasions accommodates immediately,
    // superseding the belief with the invited revision (lineage kept, ledger reset).
    const r = applyOps(state, [{ op: "supersede", targetId: bel.id, text: revised, surprise: "strong", salience: 1.0 }], cycle, date, ACCOMMODATE_THRESHOLD_RUN3C, ACCOMMODATION_OPTIONS);
    const acc = r.outcomes.find((o) => o.outcome === "accommodated");
    if (acc) fired.push({ targetId: bel.id, detail: `engine-invited revision over ${occ} sessions: ${acc.detail}` });
  }
  return fired;
}

async function probeAndScore(
  fixture: ProbesFile, policy: Policy3C, cycle: number, date: string, projection: string,
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
      maxTokens: PROBE_MAX_TOKENS_RUN3C, label: `probe ${probe.id} ${policy} cycle ${cycle}`,
    });
    const key = applicableKey(probe, cycle)!;
    const score = scoreProbe(probe, key, answer, ctx);
    return { id: probe.id, metric: probe.metric, question: probe.question, answer, score, keyCycles } satisfies ProbeAnswer;
  });
  return { policy, cycle, date, probes: answered };
}

function computeScoreRecord(
  fixture: ProbesFile, sessionDates: string[], policy: Policy3C, cycle: number, projection: string, answers: AnswersFile,
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

function writeSummaries(records: ScoreRecord[], policies: Policy3C[], cycles: number) {
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
  const out: string[] = ["# Entity-model coherence — run 3c trajectory (C validation, v4 key, threshold 0.8 + four rules)", ""];
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

// Ledger trajectory: cycle × bucket cumulative total + distinct sessions, with the threshold
// line, per-bucket cap/occasions annotations, and the minted/rerouted/refused rule events.
function writeLedgerTrajectory(ledgerCycles: LedgerCycle[], threshold: number) {
  writeFileSync(join(RESULTS_DIR, "ledger-trajectory.json"), JSON.stringify(ledgerCycles, null, 2) + "\n");
  const keys = new Set<string>();
  for (const lc of ledgerCycles) for (const row of lc.snapshot) keys.add(row.key);
  const keyList = [...keys];
  const meta = (k: string) => {
    for (const lc of ledgerCycles) {
      const row = lc.snapshot.find((r) => r.key === k);
      if (row?.targetText) return { section: row.targetSection, identity: row.identityBelief, text: row.targetText.slice(0, 40) };
    }
    return { section: undefined, identity: false, text: "" };
  };
  const cap = (PER_EVENT_CAP_FRACTION * threshold).toFixed(3);
  const decoyBand = (0.4 * threshold).toFixed(3);
  const out: string[] = [
    `# Ledger trajectory — run 3c (C validation), threshold = ${threshold.toFixed(1)} (= 1.0 × person inertia 0.8)`, "",
    `Four rules ON: protected-exclusion, deterministic belief-minting, per-event cap ${cap} (= ${PER_EVENT_CAP_FRACTION} × threshold), ≥ ${MIN_DISTINCT_SESSIONS} distinct occasions.`, "",
    "Cumulative ledger total per bucket per cycle (and distinct sessions in parens).",
    "A bucket accommodates the cycle it crosses the threshold AND has ≥ 3 distinct occasions (core/belief only).", "",
    "## Bucket legend", "",
  ];
  for (const k of keyList) {
    const m = meta(k);
    out.push(`- \`${k}\` — [${m.section}${m.identity ? ", IDENTITY-BELIEF" : ""}] ${m.text}`);
  }
  out.push("", "## Cumulative total (distinct sessions) by cycle", "", `| cycle | hygiene | ${keyList.map((k) => `\`${k}\``).join(" | ")} | rule events |`, `| --- | --- | ${keyList.map(() => "---").join(" | ")} | --- |`);
  for (const lc of ledgerCycles) {
    const cells = keyList.map((k) => {
      const row = lc.snapshot.find((r) => r.key === k);
      return row ? `${row.total.toFixed(3)} (${row.distinctSessions})` : "";
    });
    const events: string[] = [];
    if (lc.mintedThisCycle.length) events.push(`mint:${lc.mintedThisCycle.length}`);
    if (lc.reroutedThisCycle.length) events.push(`reroute:${lc.reroutedThisCycle.length}`);
    if (lc.refusedThisCycle.length) events.push(`refused:${lc.refusedThisCycle.length}`);
    if (lc.accommodatedThisCycle.length) events.push(`ACCOMMODATED:${lc.accommodatedThisCycle.map((a) => a.targetId).join(",")}`);
    out.push(`| ${lc.cycle} | ${lc.hygieneRan ? "Y" : ""} | ${cells.join(" | ")} | ${events.join(" ") || ""} |`);
  }
  out.push(
    "",
    `Threshold line: **${threshold.toFixed(1)}**. Per-event cap: **${cap}**. Decoy band (spec): a decoy bucket must stay < 40% of threshold = **${decoyBand}** at every cycle AND never reach ${MIN_DISTINCT_SESSIONS} distinct occasions.`,
    "",
  );
  writeFileSync(join(RESULTS_DIR, "ledger-trajectory.md"), out.join("\n") + "\n");
}

function dryRun(fixture: ProbesFile, cycles: number) {
  for (const probe of fixture.probes) {
    for (const [from, to] of probe.keys.map((k) => k.cycles)) {
      if (from < 1 || to > TOTAL_CYCLES_RUN3C || from > to) throw new Error(`Probe ${probe.id}: invalid cycle range [${from}, ${to}]`);
    }
  }
  if (!fixture.statedDates || fixture.statedDates.length === 0) throw new Error("v4 key has no statedDates");
  const sessions = loadSessions(cycles);
  const T = ACCOMMODATE_THRESHOLD_RUN3C;
  const O = ACCOMMODATION_OPTIONS;

  // Rule 2 — an identity-claim add MINTS a live belief (deterministic).
  const s = emptyState();
  const r0 = applyOps(s, [
    { op: "add", section: "protected", text: "ambition's been my whole spine", salience: 0.9, surprise: "low", identityClaim: true },
  ], 1, sessions[0].date, T, O);
  if (!r0.outcomes.some((o) => o.outcome === "minted")) throw new Error("dry-run: rule 2 identity-belief minting did NOT fire");
  const bel = s.items.find((i) => i.section === "belief" && i.identityBelief);
  if (!bel) throw new Error("dry-run: minted identity belief not present in state");

  // Rule 3 — a single strong note_mismatch against the belief is CAPPED at 0.4 × 0.8 = 0.32.
  const r1 = applyOps(s, [{ op: "note_mismatch", targetId: bel.id, note: "flat", surprise: "strong", salience: 1.0 }], 2, sessions[1].date, T, O);
  if (r1.outcomes[0].outcome !== "deferred") throw new Error("dry-run: single capped event should DEFER, not accommodate");
  const cap = PER_EVENT_CAP_FRACTION * T;
  if (Math.abs(s.ledger[bel.id].total - cap) > 1e-9) throw new Error(`dry-run: per-event cap wrong — got ${s.ledger[bel.id].total}, expected ${cap}`);

  // Rule 4 — a 2nd distinct session crosses 0.8 in total (0.64→with a strong supersede pending),
  // but two occasions must NOT accommodate; a 3rd distinct session does.
  const r2 = applyOps(s, [{ op: "supersede", targetId: bel.id, text: "career is not central", salience: 1.0, surprise: "strong" }], 3, sessions[2].date, T, O);
  if (r2.outcomes[0].outcome !== "deferred") throw new Error("dry-run: 2-session evidence must DEFER on the occasions rule");
  const r3 = applyOps(s, [{ op: "note_mismatch", targetId: bel.id, note: "sustained change", surprise: "strong", salience: 1.0 }], 4, sessions[3].date, T, O);
  if (!r3.outcomes.some((o) => o.outcome === "accommodated")) throw new Error("dry-run: 3 distinct sessions over threshold should ACCOMMODATE");

  // Rule 1 — protected items are never ledger targets; contradiction reroutes to the belief.
  const s2 = emptyState();
  applyOps(s2, [{ op: "add", section: "protected", text: "the person who is her work", salience: 0.9, surprise: "low", identityClaim: true }], 1, sessions[0].date, T, O);
  const prot = s2.items.find((i) => i.section === "protected")!;
  const rr = applyOps(s2, [{ op: "note_mismatch", targetId: prot.id, note: "contradicts", surprise: "mild", salience: 0.6 }], 2, sessions[1].date, T, O);
  if (!rr.outcomes.some((o) => o.outcome === "rerouted")) throw new Error("dry-run: rule 1 protected reroute did NOT fire");
  if ([...Object.keys(s2.ledger)].some((k) => s2.items.find((i) => i.id === k)?.section === "protected")) {
    throw new Error("dry-run: a protected item became a ledger target (rule 1 violated)");
  }
  // A protected target with NO live belief must be REFUSED, not accumulated.
  const s3 = emptyState();
  applyOps(s3, [{ op: "add", section: "protected", text: "a tender moment", salience: 0.9, surprise: "low" }], 1, sessions[0].date, T, O);
  const pid = s3.items.find((i) => i.section === "protected")!.id;
  const rf = applyOps(s3, [{ op: "note_mismatch", targetId: pid, note: "x", surprise: "mild", salience: 0.5 }], 2, sessions[1].date, T, O);
  if (rf.outcomes[0].outcome !== "rejected") throw new Error("dry-run: protected target with no belief should be REFUSED");
  if (Object.keys(s3.ledger).length !== 0) throw new Error("dry-run: refused protected target must not open a ledger");

  console.log("Per-cycle applicable probe counts:");
  for (let c = 1; c <= cycles; c++) {
    const count = fixture.probes.filter((probe) => applicableKey(probe, c) !== null).length;
    console.log(`  cycle ${pad(c)}: ${count} probe(s)${HYGIENE_CYCLES.has(c) ? "  [hygiene]" : ""}`);
  }
  console.log(`Dry run OK (threshold ${T}; four rules verified: mint, cap ${cap}, occasions ≥ ${MIN_DISTINCT_SESSIONS}, protected-exclusion + reroute + refuse).`);
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
        // C: assimilate (threshold 0.8 + four rules), then ops-gated hygiene on hygiene cycles.
        const ops = await proposeOps(state, cycle, session.date, session.transcript);
        const applied: { outcomes: OpOutcome[] } = applyOps(state, ops, cycle, session.date, ACCOMMODATE_THRESHOLD_RUN3C, ACCOMMODATION_OPTIONS);
        const outc = applied.outcomes;
        // Rule 4, completed: after the ops land, the engine invites a revision for any belief
        // whose ledger crossed threshold + occasions (in-band). Inline supersede-accommodations
        // (if the maintainer volunteered one) and engine-invited ones both count.
        const invited = await accommodatePass(state, cycle, session.date);
        const accommodatedThisCycle = [
          ...outc.filter((o) => o.outcome === "accommodated").map((o) => ({ targetId: (o.op as { targetId?: string }).targetId ?? "?", detail: o.detail })),
          ...invited,
        ];
        const mintedThisCycle = outc.filter((o) => o.outcome === "minted").map((o) => ({ detail: o.detail }));
        const reroutedThisCycle = outc.filter((o) => o.outcome === "rerouted").map((o) => ({ detail: o.detail }));
        const refusedThisCycle = outc.filter((o) => o.outcome === "rejected" && /protected|refused-target/i.test(o.detail)).map((o) => ({ detail: o.detail }));
        writeFileSync(p.ops(cycle), JSON.stringify({ cycle, date: session.date, threshold: ACCOMMODATE_THRESHOLD_RUN3C, outcomes: outc }, null, 2) + "\n");

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

        const lc: LedgerCycle = { cycle, date: session.date, threshold: ACCOMMODATE_THRESHOLD_RUN3C, snapshot: ledgerSnapshot(state), accommodatedThisCycle, mintedThisCycle, reroutedThisCycle, refusedThisCycle, hygieneRan };
        writeFileSync(p.ledger(cycle), JSON.stringify(lc, null, 2) + "\n");
        ledgerCycles.push(lc);

        answers = await probeAndScore(fixture, policy, cycle, session.date, projection);
        writeFileSync(ansPath, JSON.stringify(answers, null, 2) + "\n");
        const counts = outc.reduce<Record<string, number>>((acc, o) => { acc[o.outcome] = (acc[o.outcome] ?? 0) + 1; return acc; }, {});
        const hSummary = hygieneRan ? `; hygiene ${hygieneOutcomes.filter((o) => o.outcome === "applied").length} applied / ${hygieneOutcomes.filter((o) => o.outcome === "rejected").length} rejected (pinned: ${pinnedList.length})` : "";
        const ruleSummary = [
          mintedThisCycle.length ? `MINT ${mintedThisCycle.length}` : "",
          reroutedThisCycle.length ? `REROUTE ${reroutedThisCycle.length}` : "",
          refusedThisCycle.length ? `REFUSE ${refusedThisCycle.length}` : "",
          accommodatedThisCycle.length ? `ACCOMMODATED ${accommodatedThisCycle.map((a) => a.targetId).join(",")}` : "",
        ].filter(Boolean).join("; ");
        console.log(`[C] cycle ${pad(cycle)}: ${ops.length} ops (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")})${ruleSummary ? "; " + ruleSummary : ""}${hSummary} + probed (${answers.probes.length})`);
      }

      prevProjection = projection;
      records.push(computeScoreRecord(fixture, sessionDates, policy, cycle, projection, answers));
      writeSummaries(records, args.policies, args.cycles);
      if (policy === "C") writeLedgerTrajectory(ledgerCycles, ACCOMMODATE_THRESHOLD_RUN3C);
    }
  }
  console.log(`Done. ${records.length} cycle records written to ${RESULTS_DIR}`);
}

main().catch((err) => {
  console.error(`\nABORTED: ${err instanceof Error ? err.message : String(err)}`);
  console.error("Partial results (if any) remain on disk.");
  process.exit(1);
});
