// The four accommodation-iteration rules (run 3c) in the experiment engine. Verifies each
// rule AND that run-2/3/3b behavior is unchanged when no options are passed.
import { describe, expect, test } from "bun:test";
import { applyOps, emptyState, type AccommodationOptions, type ModelState } from "./model.ts";
import { ACCOMMODATE_THRESHOLD_RUN3C, ACCOMMODATION_OPTIONS, PER_EVENT_CAP_FRACTION, MIN_DISTINCT_SESSIONS } from "./run3c-config.ts";

const T = ACCOMMODATE_THRESHOLD_RUN3C; // 0.8
const O: AccommodationOptions = ACCOMMODATION_OPTIONS;
const D = (n: number) => `2025-${String(n).padStart(2, "0")}-01`; // distinct date strings (session keys)

function seedIdentityBelief(): { state: ModelState; belId: string } {
  const state = emptyState();
  const r = applyOps(state, [{ op: "add", section: "protected", text: "ambition's been my whole spine", salience: 0.9, surprise: "low", identityClaim: true }], 1, D(1), T, O);
  expect(r.outcomes.some((o) => o.outcome === "minted")).toBe(true);
  const belId = state.items.find((i) => i.section === "belief" && i.identityBelief)!.id;
  return { state, belId };
}

describe("rule 2 — deterministic belief-minting", () => {
  test("an identity-claim add mints a live belief; idempotent", () => {
    const { state, belId } = seedIdentityBelief();
    expect(belId).toBeDefined();
    // a second identity claim about the same disposition dedups (no second belief)
    const r = applyOps(state, [{ op: "add", section: "protected", text: "ambition has always been my whole spine, my engine", salience: 0.9, surprise: "low", identityClaim: true }], 2, D(2), T, O);
    expect(r.outcomes.some((o) => o.outcome === "minted")).toBe(false);
    expect(state.items.filter((i) => i.section === "belief" && i.status === "active").length).toBe(1);
  });

  test("no mint below salience 0.6, nor without the flag", () => {
    const state = emptyState();
    const low = applyOps(state, [{ op: "add", section: "protected", text: "a claim", salience: 0.4, surprise: "low", identityClaim: true }], 1, D(1), T, O);
    const plain = applyOps(state, [{ op: "add", section: "protected", text: "another", salience: 0.95, surprise: "low" }], 1, D(1), T, O);
    expect(low.outcomes.some((o) => o.outcome === "minted")).toBe(false);
    expect(plain.outcomes.some((o) => o.outcome === "minted")).toBe(false);
    expect(state.items.filter((i) => i.section === "belief").length).toBe(0);
  });
});

describe("rule 3 — per-event cap", () => {
  test("a single strong event against the belief is capped at 0.4 × threshold", () => {
    const { state, belId } = seedIdentityBelief();
    applyOps(state, [{ op: "note_mismatch", targetId: belId, note: "flat", surprise: "strong", salience: 1.0 }], 2, D(2), T, O);
    expect(state.ledger[belId].total).toBeCloseTo(PER_EVENT_CAP_FRACTION * T, 9); // 0.32
  });
});

describe("rule 4 — distinct occasions", () => {
  test("over threshold but < 3 distinct sessions does NOT accommodate; a 3rd session flips it", () => {
    const { state, belId } = seedIdentityBelief();
    // event 1 (session 2): 0.32
    applyOps(state, [{ op: "note_mismatch", targetId: belId, note: "e1", surprise: "strong", salience: 1.0 }], 2, D(2), T, O);
    // event 2 (session 3): supersede carries the pending revision → 0.64, 2 sessions, < 0.8 → defer
    const r2 = applyOps(state, [{ op: "supersede", targetId: belId, text: "career no longer central", salience: 1.0, surprise: "strong" }], 3, D(3), T, O);
    expect(r2.outcomes[0].outcome).toBe("deferred");
    expect(state.items.find((i) => i.id === belId)!.status).toBe("active");
    // event 3 (session 4): 0.96 ≥ 0.8 AND 3 distinct sessions → accommodate with the pending revision
    const r3 = applyOps(state, [{ op: "note_mismatch", targetId: belId, note: "sustained", surprise: "strong", salience: 1.0 }], 4, D(4), T, O);
    expect(r3.outcomes.some((o) => o.outcome === "accommodated")).toBe(true);
    expect(state.items.find((i) => i.id === belId)!.status).toBe("superseded");
  });

  test("the minimum-sessions constant is 3", () => {
    expect(MIN_DISTINCT_SESSIONS).toBe(3);
  });
});

describe("rule 1 — protected-exclusion + reroute", () => {
  test("a contradiction against a protected identity claim reroutes to its minted belief", () => {
    const { state, belId } = seedIdentityBelief();
    const prot = state.items.find((i) => i.section === "protected")!;
    const r = applyOps(state, [{ op: "note_mismatch", targetId: prot.id, note: "contradicts", surprise: "mild", salience: 0.6 }], 2, D(2), T, O);
    expect(r.outcomes.some((o) => o.outcome === "rerouted")).toBe(true);
    // no protected item ever became a ledger key
    expect(Object.keys(state.ledger).some((k) => state.items.find((i) => i.id === k)?.section === "protected")).toBe(false);
    // the evidence landed on the belief
    expect(state.ledger[belId].total).toBeGreaterThan(0);
  });

  test("a contradiction against a protected item with NO belief is refused (no ledger opened)", () => {
    const state = emptyState();
    applyOps(state, [{ op: "add", section: "protected", text: "a tender moment", salience: 0.9, surprise: "low" }], 1, D(1), T, O);
    const pid = state.items.find((i) => i.section === "protected")!.id;
    const r = applyOps(state, [{ op: "note_mismatch", targetId: pid, note: "x", surprise: "mild", salience: 0.5 }], 2, D(2), T, O);
    expect(r.outcomes[0].outcome).toBe("rejected");
    expect(Object.keys(state.ledger).length).toBe(0);
  });

  test("supersede of a protected item is still refused when exclusion is on but reroutes if a belief exists", () => {
    const { state } = seedIdentityBelief();
    const prot = state.items.find((i) => i.section === "protected")!;
    const r = applyOps(state, [{ op: "supersede", targetId: prot.id, text: "flattened", salience: 0.9, surprise: "strong" }], 2, D(2), T, O);
    expect(r.outcomes.some((o) => o.outcome === "rerouted")).toBe(true);
    expect(prot.status).toBe("active"); // the verbatim itself is never rewritten
  });
});

describe("backward-compat — no options = the pre-iteration engine", () => {
  test("without options, a protected identity claim mints nothing and a single strong core event uses the old (uncapped) math", () => {
    const state = emptyState();
    applyOps(state, [{ op: "add", section: "protected", text: "ambition's been my whole spine", salience: 0.9, surprise: "low", identityClaim: true }], 1, D(1), 1.0);
    expect(state.items.some((i) => i.section === "belief")).toBe(false); // no minting without opts
    // old core-supersede physics (uncapped): strong × 0.8 × medium = 0.6 accrues raw
    applyOps(state, [{ op: "add", section: "core", text: "career central", salience: 0.6, surprise: "none" }], 1, D(1), 1.0);
    const core = state.items.find((i) => i.section === "core")!;
    applyOps(state, [{ op: "supersede", targetId: core.id, text: "reframed", salience: 0.8, surprise: "strong" }], 2, D(2), 1.0);
    expect(state.ledger[core.id].total).toBeCloseTo(0.6, 9); // uncapped raw weight
  });
});
