// Deterministic guards for the ops-gated compaction engine (run 3). The auto-pin,
// sacred-verbatim, and no-re-derivation refusals must hold in CODE regardless of what the
// hygiene model happens to propose live — so they are proven here, not just observed.
import { expect, test } from "bun:test";
import { applyOps, emptyState, render, type ModelState } from "./model.ts";
import { applyHygieneOps, computePinnedIds, type HygieneOp } from "./hygiene.ts";

// A small state: a protected verbatim, a belief with an OPEN ledger bucket, and two mergeable
// current-state items. Threshold 3.0 so the belief supersede DEFERS (bucket stays open).
function fixtureState(): ModelState {
  const s = emptyState();
  applyOps(s, [
    { op: "add", section: "protected", text: "let her go into the wind", salience: 0.9, surprise: "low" }, // sal-1
    { op: "add", section: "belief", text: "career is central to identity", salience: 0.6, surprise: "none", confidence: "medium" }, // bel-2
    { op: "add", section: "current", text: "jogging up to 30 minutes", salience: 0.3, surprise: "none" }, // cs-3
    { op: "add", section: "current", text: "jogging up to 40 minutes", salience: 0.3, surprise: "none" }, // cs-4
    { op: "supersede", targetId: "bel-2", text: "career reframed as peripheral", salience: 0.8, surprise: "strong" }, // defers → opens ledger on bel-2
  ], 1, "2025-07-19", 3.0);
  return s;
}

test("open belief supersede defers under threshold 3.0 and opens a ledger bucket", () => {
  const s = fixtureState();
  expect(s.ledger["bel-2"].total).toBeGreaterThan(0);
  expect(s.items.find((i) => i.id === "bel-2")!.status).toBe("active"); // not accommodated
});

test("auto-pin = protected items ∪ open-ledger target items", () => {
  const s = fixtureState();
  const pinned = computePinnedIds(s);
  expect(pinned.has("sal-1")).toBe(true); // protected
  expect(pinned.has("bel-2")).toBe(true); // open-ledger target
  expect(pinned.has("cs-3")).toBe(false); // ordinary current item — compactable
});

test("demote of an open-ledger belief is REFUSED (starvation guard)", () => {
  const s = fixtureState();
  const pinned = computePinnedIds(s);
  const { outcomes } = applyHygieneOps(s, [{ op: "demote", targetId: "bel-2", reason: "wobbling" }], "2025-09-06", pinned);
  expect(outcomes[0].outcome).toBe("rejected");
  expect(s.items.find((i) => i.id === "bel-2")!.status).toBe("active"); // survived
  expect(s.ledger["bel-2"].total).toBeGreaterThan(0); // evidence intact
});

test("prose.compress of a protected verbatim is REFUSED (sacred-verbatim guard)", () => {
  const s = fixtureState();
  const pinned = computePinnedIds(s);
  const { outcomes } = applyHygieneOps(s, [{ op: "prose.compress", targetId: "sal-1", text: "wind" }], "2025-09-06", pinned);
  expect(outcomes[0].outcome).toBe("rejected");
  expect(s.items.find((i) => i.id === "sal-1")!.text).toBe("let her go into the wind"); // byte-identical
});

test("a non-compaction op (supersede) during hygiene is REFUSED (no fresh derivation)", () => {
  const s = fixtureState();
  const pinned = computePinnedIds(s);
  const { outcomes } = applyHygieneOps(s, [{ op: "supersede", targetId: "cs-3", text: "re-judged" } as unknown as HygieneOp], "2025-09-06", pinned);
  expect(outcomes[0].outcome).toBe("rejected");
  expect(outcomes[0].detail).toContain("not a compaction op");
});

test("gist.merge of unpinned same-section items archives sources with lineage and adds a linked successor", () => {
  const s = fixtureState();
  const pinned = computePinnedIds(s);
  const { outcomes } = applyHygieneOps(s, [{ op: "gist.merge", targetIds: ["cs-3", "cs-4"], text: "jogging 30->40 min over the period" }], "2025-09-06", pinned);
  expect(outcomes[0].outcome).toBe("applied");
  const src3 = s.items.find((i) => i.id === "cs-3")!;
  const src4 = s.items.find((i) => i.id === "cs-4")!;
  expect(src3.status).toBe("archived");
  expect(src4.status).toBe("archived");
  expect(src3.mergedInto).toBe(src4.mergedInto); // same successor
  const successor = s.items.find((i) => i.id === src3.mergedInto)!;
  expect(successor.status).toBe("active");
  expect(successor.derivedFrom).toEqual(["cs-3", "cs-4"]); // lineage kept
});

test("gist.merge is refused for <2 sources, cross-section, or a pinned source", () => {
  const s = fixtureState();
  const pinned = computePinnedIds(s);
  const tooFew = applyHygieneOps(s, [{ op: "gist.merge", targetIds: ["cs-3"], text: "x" }], "d", pinned).outcomes[0];
  expect(tooFew.outcome).toBe("rejected");
  const crossSection = applyHygieneOps(s, [{ op: "gist.merge", targetIds: ["cs-3", "bel-2"], text: "x" }], "d", pinned).outcomes[0];
  expect(crossSection.outcome).toBe("rejected"); // bel-2 pinned AND cross-section
});

test("prose.compress must shorten (rejects expansion / re-derivation) on an unpinned item", () => {
  const s = fixtureState();
  const pinned = computePinnedIds(s);
  const longer = applyHygieneOps(s, [{ op: "prose.compress", targetId: "cs-3", text: "jogging up to thirty minutes, expanded with extra words" }], "d", pinned).outcomes[0];
  expect(longer.outcome).toBe("rejected");
  const shorter = applyHygieneOps(s, [{ op: "prose.compress", targetId: "cs-3", text: "jogging ~30 min" }], "d", pinned).outcomes[0];
  expect(shorter.outcome).toBe("applied");
});

test("archived items are absent from the active render but remain resolvable in state", () => {
  const s = fixtureState();
  const pinned = computePinnedIds(s);
  applyHygieneOps(s, [{ op: "gist.merge", targetIds: ["cs-3", "cs-4"], text: "jogging progressed 30->40 min" }], "2025-09-06", pinned);
  const proj = render(s, false);
  expect(proj).not.toContain("jogging up to 30 minutes"); // source gone from wake
  expect(proj).toContain("jogging progressed 30->40 min"); // successor present
  expect(s.items.find((i) => i.id === "cs-3")).toBeDefined(); // still resolvable in state
});
