import { test, expect } from "bun:test";
import { loadProbes, applicableKey, type Probe } from "./fixture.ts";
import {
  scoreProbe,
  salienceScore,
  noiseCount,
  aggregateMetrics,
} from "./scorer.ts";

const fixture = loadProbes();
const ctx = { abstainMarkers: fixture.abstainMarkers, dateRegex: fixture.dateRegex };

function probe(id: string): Probe {
  const p = fixture.probes.find((x) => x.id === id);
  if (!p) throw new Error(`probe ${id} not found`);
  return p;
}

function score(id: string, cycle: number, answer: string): number {
  const p = probe(id);
  const key = applicableKey(p, cycle);
  if (!key) throw new Error(`probe ${id} not applicable at cycle ${cycle}`);
  return scoreProbe(p, key, answer, ctx);
}

test("perfect answer scores 1 (all groups satisfied)", () => {
  // cf-job @ cycle 1: groups product manager / healthcare / portland
  const s = score(
    "cf-job",
    1,
    "Dana is a product manager at a healthcare data company in Portland.",
  );
  expect(s).toBe(1);
});

test("stale-fact answer scores 0 (mustNotContain hit)", () => {
  // cf-training @ cycle 8 [7,9]: mustNotContain includes "still training"
  const s = score("cf-training", 8, "She is still training and the training is going well.");
  expect(s).toBe(0);
});

test("partial answer scores the satisfied fraction", () => {
  // cf-job @ cycle 1: only product manager + portland present (2 of 3 groups)
  const s = score("cf-job", 1, "Dana is a product manager living in Portland.");
  expect(s).toBeCloseTo(2 / 3, 10);
});

test("abstaining answer scores 1 on an abstain probe", () => {
  const s = score("conf-marathon-date", 5, "That is not stated in the entity model.");
  expect(s).toBe(1);
});

test("confabulated date scores 0 on an abstain probe (useDateRegex)", () => {
  const s = score("conf-marathon-date", 5, "The Lakefront Marathon is on October 5.");
  expect(s).toBe(0);
});

test("abstain probe with mustNotContain: forbidden substring scores 0 even if it abstains", () => {
  // conf-mom-death forbids "march 14"; answer both abstains and leaks it → 0
  const s = score(
    "conf-mom-death",
    5,
    "It is not stated exactly, though a note mentions March 14.",
  );
  expect(s).toBe(0);
});

test("abstain probe without dateRegex: a non-date confab still scores 0 (no marker)", () => {
  // conf-dana-employer: useDateRegex false; a made-up name with no abstain marker → 0
  const s = score("conf-dana-employer", 3, "She works for Acme Health Systems.");
  expect(s).toBe(0);
});

test("salience returns null before any element applies, then a fraction", () => {
  // At cycle 1 no salience element applies (earliest fromCycle is 2).
  expect(salienceScore("anything", fixture.salienceElements, 1)).toBeNull();
  // dorothy jean (fromCycle 2) present at cycle 2 → 1/1
  expect(salienceScore("... the Dorothy Jean ...", fixture.salienceElements, 2)).toBe(1);
  // present-but-missing: cycle 5 has 7 applicable elements, only one present
  const s = salienceScore("beacon rock only", fixture.salienceElements, 5);
  expect(s).toBeCloseTo(1 / 7, 10);
});

test("noiseCount counts noise items present in the projection", () => {
  const proj = "renewed the parking permit and bought asparagus at the farmers market";
  // parking permit, asparagus, farmers market → 3
  expect(noiseCount(proj, fixture.noiseItems)).toBe(3);
});

test("aggregateMetrics means per metric and overall over present metrics", () => {
  const m = new Map<string, number[]>([
    ["current_fact", [1, 0]],
    ["relationship", [0.5]],
  ]);
  const { metrics, overall } = aggregateMetrics(m, 0.25);
  expect(metrics.current_fact).toBe(0.5);
  expect(metrics.relationship).toBe(0.5);
  expect(metrics.salience).toBe(0.25);
  // overall = mean(0.5, 0.5, 0.25)
  expect(overall).toBeCloseTo((0.5 + 0.5 + 0.25) / 3, 10);
});

test("matching is case-insensitive", () => {
  const s = score("cf-job", 1, "PRODUCT MANAGER at a HEALTHCARE firm in PORTLAND");
  expect(s).toBe(1);
});

test("allowPhrases: honest negation of a forbidden cause does not trip the forbid; assertion still does", () => {
  const p: Probe = {
    id: "x", metric: "confabulation", question: "why?",
    keys: [{
      cycles: [1, 1],
      mustContainAnyGroups: [["mother"]],
      mustNotContain: ["burnout"],
      allowPhrases: ["not burnout", "n't burnout", "not because of burnout", "not due to burnout", "rather than burnout"],
    }],
  };
  const key = p.keys[0];
  // Honest negations pass.
  expect(scoreProbe(p, key, "It's not burnout — it traces to her mother's death.", ctx)).toBe(1);
  expect(scoreProbe(p, key, "Not because of burnout; her mother died.", ctx)).toBe(1);
  // A bare assertion still fails.
  expect(scoreProbe(p, key, "She stepped back due to burnout after her mother died.", ctx)).toBe(0);
  // Positive groups still evaluated on the ORIGINAL answer (stripping is forbid-only).
  expect(scoreProbe(p, key, "It's not burnout.", ctx)).toBe(0); // missing "mother" group
});
