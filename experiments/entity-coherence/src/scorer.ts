// Deterministic scoring — no LLM judging. Implements the "Scoring" section of the spec.
import type { Probe, ProbeKey, SalienceElement } from "./fixture.ts";

export function normalize(s: string): string {
  return s.toLowerCase();
}

// Plain substring containment on normalized (lowercased) text.
function contains(haystack: string, needle: string): boolean {
  return normalize(haystack).includes(normalize(needle));
}

function anyContained(answer: string, needles: string[]): boolean {
  return needles.some((n) => contains(answer, n));
}

export type ScoreContext = {
  abstainMarkers: string[];
  dateRegex: string;
  // Dates actually stated in the fixture. An abstaining answer may cite these as
  // honest grounding; they are stripped before the confabulation dateRegex test so
  // only dates NOT in the source count as fabrication.
  statedDates?: string[];
};

// Score a single applicable probe against a raw answer. Returns a number in [0, 1].
// Strip a key's allowPhrases (longest first, case-insensitive) from an answer. Used ONLY for
// the mustNotContain test: an honest negation ("it's not burnout") must not substring-trip the
// forbidden assertion ("burnout"). Positive groups still match the original answer.
function stripAllowPhrases(answer: string, key: ProbeKey): string {
  if (!key.allowPhrases || key.allowPhrases.length === 0) return answer;
  let out = normalize(answer);
  const phrases = [...key.allowPhrases].sort((a, b) => b.length - a.length);
  for (const ph of phrases) out = out.split(normalize(ph)).join(" ");
  return out;
}

export function scoreProbe(
  probe: Probe,
  key: ProbeKey,
  answer: string,
  ctx: ScoreContext,
): number {
  const lower = normalize(answer);
  const forbidTestText = stripAllowPhrases(answer, key);

  if (probe.abstain) {
    // (a) at least one abstain marker present
    const hasMarker = ctx.abstainMarkers.some((m) => lower.includes(normalize(m)));
    if (!hasMarker) return 0;
    // (b) no mustNotContain entry present
    if (anyContained(forbidTestText, key.mustNotContain)) return 0;
    // (c) if useDateRegex, answer must NOT match dateRegex (case-insensitive)
    if (probe.useDateRegex) {
      let tested = normalize(answer);
      for (const d of ctx.statedDates ?? []) {
        tested = tested.split(normalize(d)).join(" ");
      }
      const re = new RegExp(ctx.dateRegex, "i");
      if (re.test(tested)) return 0;
    }
    return 1;
  }

  // Regular probe.
  if (anyContained(forbidTestText, key.mustNotContain)) return 0;
  const groups = key.mustContainAnyGroups;
  if (groups.length === 0) return 1; // no positive requirements → full credit
  let satisfied = 0;
  for (const group of groups) {
    if (anyContained(answer, group)) satisfied++;
  }
  return satisfied / groups.length;
}

// Salience metric: fraction of salience elements with fromCycle <= cycle whose
// `element` string appears (case-insensitive substring) in the projection text.
// Returns null when no element applies yet (denominator 0) so it can be omitted.
export function salienceScore(
  projection: string,
  elements: SalienceElement[],
  cycle: number,
): number | null {
  const applicable = elements.filter((e) => e.fromCycle <= cycle);
  if (applicable.length === 0) return null;
  let present = 0;
  for (const e of applicable) {
    const forms = [e.element, ...(e.anyOf ?? [])];
    if (forms.some((f) => contains(projection, f))) present++;
  }
  return present / applicable.length;
}

// Noise intrusion: count of noise items present in the projection text.
export function noiseCount(projection: string, noiseItems: string[]): number {
  let count = 0;
  for (const item of noiseItems) {
    if (contains(projection, item)) count++;
  }
  return count;
}

// Aggregate per-probe scores into per-metric means, then an overall mean of the
// metric values present. `probeScores` maps metric -> list of scores this cycle.
export function aggregateMetrics(
  probeScores: Map<string, number[]>,
  salience: number | null,
): { metrics: Record<string, number>; overall: number } {
  const metrics: Record<string, number> = {};
  for (const [metric, scores] of probeScores) {
    if (scores.length === 0) continue;
    metrics[metric] = scores.reduce((a, b) => a + b, 0) / scores.length;
  }
  if (salience !== null) metrics.salience = salience;

  const values = Object.values(metrics);
  const overall = values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
  return { metrics, overall };
}
