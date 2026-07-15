// Fixture loading + types for probes.json and the session transcripts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
export const EXPERIMENT_DIR = join(HERE, "..");
export const FIXTURE_DIR = join(EXPERIMENT_DIR, "fixture");
export const SESSIONS_DIR = join(FIXTURE_DIR, "sessions");

export type ProbeKey = {
  cycles: [number, number];
  mustContainAnyGroups: string[][];
  mustNotContain: string[];
  // v5 (run 3): phrases stripped from the answer BEFORE the mustNotContain test (and only that
  // test). Mechanism precedented by v2.1's statedDates stripping: honest negations of a
  // forbidden cause ("it's not burnout") must not substring-trip the forbid ("burnout").
  allowPhrases?: string[];
};

export type Probe = {
  id: string;
  metric: string;
  question: string;
  abstain?: boolean;
  useDateRegex?: boolean;
  keys: ProbeKey[];
};

// `anyOf`: alternate surface forms that count as the element being present
// (e.g. an ISO rendering of a stated date). Introduced by the v3 key.
export type SalienceElement = { element: string; fromCycle: number; anyOf?: string[] };

export type ProbesFile = {
  entity: string;
  notes: string;
  abstainMarkers: string[];
  dateRegex: string;
  probes: Probe[];
  salienceElements: SalienceElement[];
  noiseItems: string[];
  statedDates?: string[];
};

export type SessionFile = { index: number; date: string; transcript: string };

export function loadProbes(filename = "probes.json"): ProbesFile {
  const raw = readFileSync(join(FIXTURE_DIR, filename), "utf8");
  return JSON.parse(raw) as ProbesFile;
}

const DATE_RE = /(\d{4}-\d{2}-\d{2})/;

export function loadSession(cycle: number): SessionFile {
  const file = join(SESSIONS_DIR, `${String(cycle).padStart(2, "0")}.md`);
  const transcript = readFileSync(file, "utf8");
  const firstLine = transcript.split("\n", 1)[0] ?? "";
  const m = firstLine.match(DATE_RE);
  if (!m) {
    throw new Error(`Could not parse a session date from ${file} (first line: "${firstLine}")`);
  }
  return { index: cycle, date: m[1], transcript };
}

export function loadSessions(upToCycle: number): SessionFile[] {
  const out: SessionFile[] = [];
  for (let c = 1; c <= upToCycle; c++) out.push(loadSession(c));
  return out;
}

// Return the applicable key for a probe at cycle N (cycles[0] <= N <= cycles[1]),
// or null if the probe is not applicable this cycle.
export function applicableKey(probe: Probe, cycle: number): ProbeKey | null {
  for (const key of probe.keys) {
    if (key.cycles[0] <= cycle && cycle <= key.cycles[1]) return key;
  }
  return null;
}
