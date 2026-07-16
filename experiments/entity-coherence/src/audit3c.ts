// Audit helper for run 3c: dump every sub-1.0 probe answer (with the key that scored it) and
// every fabricated-date hit, for hand-reading. No API calls. (run-1/2/3 discipline: never trust a
// keyword score until its failures are read; artifacts against our favor stay standing.)
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { applicableKey, EXPERIMENT_DIR, loadProbes, loadSessions } from "./fixture.ts";
import { scanFabricatedDates } from "./datescan.ts";

const RESULTS = join(EXPERIMENT_DIR, "results-run3c");
const fixture = loadProbes(process.argv[2] ?? "probes-v5.json");
const CYCLES = 24;
const sessionDates = loadSessions(CYCLES).map((s) => s.date);
const pad = (n: number) => String(n).padStart(2, "0");

for (const policy of ["N", "C"]) {
  console.log(`\n===== ${policy} =====`);
  for (let cycle = 1; cycle <= CYCLES; cycle++) {
    const ansPath = join(RESULTS, "answers", policy, `cycle-${pad(cycle)}.json`);
    const projPath = join(RESULTS, "projections", policy, `cycle-${pad(cycle)}.md`);
    if (!existsSync(ansPath)) continue;
    const answers = JSON.parse(readFileSync(ansPath, "utf8"));
    for (const a of answers.probes) {
      if (a.score >= 1) continue;
      const probe = fixture.probes.find((x) => x.id === a.id)!;
      const key = applicableKey(probe, cycle)!;
      console.log(`\n--- ${policy} c${cycle} ${a.id} (${a.metric}) score=${a.score}`);
      console.log(`Q: ${a.question}`);
      console.log(`A: ${a.answer.replace(/\n/g, " ")}`);
      console.log(`key: mustNot=${JSON.stringify(key.mustNotContain)} groups=${JSON.stringify(key.mustContainAnyGroups)}${probe.abstain ? " [abstain]" : ""}${key.allowPhrases ? " allow=" + JSON.stringify(key.allowPhrases) : ""}`);
    }
    if (existsSync(projPath)) {
      const scan = scanFabricatedDates(readFileSync(projPath, "utf8"), fixture.statedDates ?? [], sessionDates);
      if (scan.count > 0) console.log(`\n[dates] ${policy} c${cycle}: ${scan.fabricated.join(", ")}`);
    }
  }
}
