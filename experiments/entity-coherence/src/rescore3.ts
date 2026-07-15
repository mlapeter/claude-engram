// Rescore run-3 saved answers/projections against a revised key (default v4). No API calls.
// Writes results-run3/rescored/{scores.json,scores.csv,trajectory.md} and prints every flipped
// probe score for hand-verification (run-1/2 audit discipline).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applicableKey, EXPERIMENT_DIR, loadProbes, loadSessions } from "./fixture.ts";
import { aggregateMetrics, noiseCount, salienceScore, scoreProbe } from "./scorer.ts";
import { scanFabricatedDates } from "./datescan.ts";

const RESULTS = join(EXPERIMENT_DIR, "results-run3");
const OUT = join(RESULTS, "rescored");
const keyFile = process.argv[2] ?? "probes-v4.json";
const fixture = loadProbes(keyFile);
const ctx = { abstainMarkers: fixture.abstainMarkers, dateRegex: fixture.dateRegex, statedDates: fixture.statedDates };
const CYCLES = 24;
const sessionDates = loadSessions(CYCLES).map((s) => s.date);

const POLICIES = ["N", "C"];
const METRICS = ["current_fact", "supersession", "lineage", "confabulation", "relationship", "reunion", "trait", "salience", "overall"];
const AUX = ["bytes", "noiseCount", "fabricatedDates"] as const;

type Rec = {
  policy: string; cycle: number; metrics: Record<string, number>;
  aux: { bytes: number; noiseCount: number; fabricatedDates: number; fabricated: string[] };
  changed: { id: string; old: number; new: number }[];
};

const records: Rec[] = [];
for (const policy of POLICIES) {
  for (let cycle = 1; cycle <= CYCLES; cycle++) {
    const nn = String(cycle).padStart(2, "0");
    const ansPath = join(RESULTS, "answers", policy, `cycle-${nn}.json`);
    const projPath = join(RESULTS, "projections", policy, `cycle-${nn}.md`);
    if (!existsSync(ansPath) || !existsSync(projPath)) { console.error(`missing ${policy} cycle ${cycle}; skipping`); continue; }
    const saved = JSON.parse(readFileSync(ansPath, "utf8"));
    const projection = readFileSync(projPath, "utf8");
    const byMetric = new Map<string, number[]>();
    const changed: Rec["changed"] = [];
    for (const rec of saved.probes) {
      const probe = fixture.probes.find((p) => p.id === rec.id);
      if (!probe) throw new Error(`unknown probe ${rec.id}`);
      const key = applicableKey(probe, cycle);
      if (!key) continue;
      const score = scoreProbe(probe, key, rec.answer, ctx);
      if (score !== rec.score) changed.push({ id: rec.id, old: rec.score, new: score });
      const list = byMetric.get(probe.metric) ?? [];
      list.push(score);
      byMetric.set(probe.metric, list);
    }
    const salience = salienceScore(projection, fixture.salienceElements, cycle);
    const { metrics, overall } = aggregateMetrics(byMetric, salience);
    metrics.overall = overall;
    const scan = scanFabricatedDates(projection, fixture.statedDates ?? [], sessionDates);
    records.push({ policy, cycle, metrics, aux: { bytes: Buffer.byteLength(projection), noiseCount: noiseCount(projection, fixture.noiseItems), fabricatedDates: scan.count, fabricated: scan.fabricated }, changed });
  }
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "scores.json"), JSON.stringify(records, null, 2) + "\n");
const csv = ["policy,cycle,metric,value"];
for (const r of records) {
  for (const m of METRICS) if (m in r.metrics) csv.push(`${r.policy},${r.cycle},${m},${r.metrics[m]}`);
  for (const a of AUX) csv.push(`${r.policy},${r.cycle},${a},${r.aux[a]}`);
}
writeFileSync(join(OUT, "scores.csv"), csv.join("\n") + "\n");
let md = `# Entity-model coherence — run 3 trajectory (N vs C+hygiene, rescored, ${keyFile})\n`;
const fmt = (v: number | undefined) => (v === undefined ? "" : v.toFixed(3));
for (const metric of METRICS) {
  md += `\n## ${metric}\n\n| cycle | N | C |\n| --- | --- | --- |\n`;
  for (let cycle = 1; cycle <= CYCLES; cycle++) md += `| ${cycle} | ${POLICIES.map((p) => fmt(records.find((x) => x.policy === p && x.cycle === cycle)?.metrics[metric])).join(" | ")} |\n`;
}
for (const aux of AUX) {
  md += `\n## ${aux} (aux)\n\n| cycle | N | C |\n| --- | --- | --- |\n`;
  for (let cycle = 1; cycle <= CYCLES; cycle++) md += `| ${cycle} | ${POLICIES.map((p) => { const v = records.find((x) => x.policy === p && x.cycle === cycle)?.aux[aux]; return v === undefined ? "" : String(v); }).join(" | ")} |\n`;
}
writeFileSync(join(OUT, "trajectory.md"), md);
const totalChanged = records.reduce((a, r) => a + r.changed.length, 0);
console.log(`rescored ${records.length} cycle records; ${totalChanged} probe scores changed`);
for (const r of records) for (const c of r.changed) console.log(`  ${r.policy} c${r.cycle} ${c.id}: ${c.old} -> ${c.new}`);
