// Rescore saved probe answers against a revised answer key (default fixture/probes-v2.json).
// No API calls — replays results/answers/*/cycle-*.json and results/projections through
// the deterministic scorer, writing results/rescored/{scores.json,scores.csv,trajectory.md}.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { EXPERIMENT_DIR, applicableKey, type ProbesFile } from "./fixture.ts";
import { scoreProbe, salienceScore, noiseCount, aggregateMetrics } from "./scorer.ts";

const RESULTS = join(EXPERIMENT_DIR, "results");
const OUT = join(RESULTS, "rescored");
const keyPath = process.argv[2] ?? join(EXPERIMENT_DIR, "fixture", "probes-v2.json");
const probesFile = JSON.parse(readFileSync(keyPath, "utf8")) as ProbesFile;
const ctx = { abstainMarkers: probesFile.abstainMarkers, dateRegex: probesFile.dateRegex, statedDates: (probesFile as any).statedDates };

const POLICIES = ["P0", "P1", "P2"];
const CYCLES = 12;
const METRICS = ["current_fact", "supersession", "lineage", "confabulation", "relationship", "reunion", "salience", "overall"];

type CycleRecord = {
  policy: string; cycle: number;
  metrics: Record<string, number>; overall: number;
  aux: { bytes: number; noiseCount: number };
  changed: { id: string; old: number; new: number }[];
};

const records: CycleRecord[] = [];
for (const policy of POLICIES) {
  for (let cycle = 1; cycle <= CYCLES; cycle++) {
    const nn = String(cycle).padStart(2, "0");
    const answersPath = join(RESULTS, "answers", policy, `cycle-${nn}.json`);
    const projPath = join(RESULTS, "projections", policy, `cycle-${nn}.md`);
    if (!existsSync(answersPath) || !existsSync(projPath)) {
      console.error(`missing ${policy} cycle ${cycle}; skipping`);
      continue;
    }
    const saved = JSON.parse(readFileSync(answersPath, "utf8"));
    const projection = readFileSync(projPath, "utf8");

    const byMetric = new Map<string, number[]>();
    const changed: CycleRecord["changed"] = [];
    for (const rec of saved.probes) {
      const probe = probesFile.probes.find((p) => p.id === rec.id);
      if (!probe) throw new Error(`unknown probe ${rec.id}`);
      const key = applicableKey(probe, cycle);
      if (!key) continue;
      const score = scoreProbe(probe, key, rec.answer, ctx);
      if (score !== rec.score) changed.push({ id: rec.id, old: rec.score, new: score });
      const list = byMetric.get(probe.metric) ?? [];
      list.push(score);
      byMetric.set(probe.metric, list);
    }
    const salience = salienceScore(projection, probesFile.salienceElements, cycle);
    const { metrics, overall } = aggregateMetrics(byMetric, salience);
    records.push({
      policy, cycle, metrics, overall,
      aux: { bytes: Buffer.byteLength(projection), noiseCount: noiseCount(projection, probesFile.noiseItems) },
      changed,
    });
  }
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "scores.json"), JSON.stringify(records, null, 2));

const csv = ["policy,cycle,metric,value"];
for (const r of records) {
  for (const [m, v] of Object.entries(r.metrics)) csv.push(`${r.policy},${r.cycle},${m},${v}`);
  csv.push(`${r.policy},${r.cycle},overall,${r.overall}`);
  csv.push(`${r.policy},${r.cycle},aux_bytes,${r.aux.bytes}`);
  csv.push(`${r.policy},${r.cycle},aux_noise,${r.aux.noiseCount}`);
}
writeFileSync(join(OUT, "scores.csv"), csv.join("\n") + "\n");

let md = "# Entity-model coherence — trajectory (rescored, v2 key)\n";
for (const metric of METRICS) {
  md += `\n## ${metric}\n\n| cycle | P0 | P1 | P2 |\n| --- | --- | --- | --- |\n`;
  for (let cycle = 1; cycle <= CYCLES; cycle++) {
    const cells = POLICIES.map((p) => {
      const r = records.find((x) => x.policy === p && x.cycle === cycle);
      const v = metric === "overall" ? r?.overall : r?.metrics[metric];
      return v === undefined ? "" : v.toFixed(3);
    });
    md += `| ${cycle} | ${cells.join(" | ")} |\n`;
  }
}
writeFileSync(join(OUT, "trajectory.md"), md);

const totalChanged = records.reduce((a, r) => a + r.changed.length, 0);
console.log(`rescored ${records.length} cycle records; ${totalChanged} probe scores changed`);
for (const r of records) {
  for (const c of r.changed) console.log(`  ${r.policy} c${r.cycle} ${c.id}: ${c.old} -> ${c.new}`);
}
