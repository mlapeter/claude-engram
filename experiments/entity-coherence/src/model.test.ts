import { describe, expect, test } from "bun:test";
import {
  ACCOMMODATE_THRESHOLD,
  applyOps,
  emptyState,
  render,
  type ModelState,
  type Op,
} from "./model.ts";
import { scanFabricatedDates } from "./datescan.ts";

const D1 = "2025-02-03";
const D2 = "2025-02-12";
const D3 = "2025-02-24";

function seeded(): ModelState {
  const state = emptyState();
  applyOps(
    state,
    [
      { op: "add", section: "core", text: "Values direct communication", salience: 0.6, surprise: "none" },
      { op: "add", section: "current", text: "Training for a marathon", salience: 0.5, surprise: "none" },
      { op: "add", section: "relationship", text: "Partner of six years, strong support", entity: "Sam", salience: 0.7, surprise: "none" },
      { op: "add", section: "thread", text: "Wants to visit Marcus in Denver this year", salience: 0.5, surprise: "none" },
      { op: "add", section: "belief", text: "Prefers to decide with data", confidence: "high", salience: 0.4, surprise: "none" },
      { op: "add", section: "protected", text: 'Her mom died this winter; "it colors everything"', salience: 0.95, surprise: "strong" },
    ],
    1,
    D1,
  );
  return state;
}

describe("applyOps", () => {
  test("add + dedup-as-reinforce", () => {
    const state = seeded();
    const { outcomes } = applyOps(
      state,
      [{ op: "add", section: "current", text: "Training for a marathon", salience: 0.5, surprise: "none" }],
      2,
      D2,
    );
    expect(outcomes[0].outcome).toBe("deduped");
    const item = state.items.find((i) => i.text === "Training for a marathon")!;
    expect(item.reinforcedBy).toEqual([D2]);
    expect(state.items.filter((i) => i.text === "Training for a marathon")).toHaveLength(1);
  });

  test("current-state supersedes immediately with lineage kept", () => {
    const state = seeded();
    const target = state.items.find((i) => i.text === "Training for a marathon")!;
    const { outcomes } = applyOps(
      state,
      [{ op: "supersede", targetId: target.id, text: "Marathon is off — sprained ankle", salience: 0.7, surprise: "strong" }],
      2,
      D2,
    );
    expect(outcomes[0].outcome).toBe("applied");
    expect(target.status).toBe("superseded");
    expect(target.supersededBy).toEqual({ text: "Marathon is off — sprained ankle", date: D2 });
    const repl = state.items.find((i) => i.text === "Marathon is off — sprained ankle")!;
    expect(repl.status).toBe("active");
    expect(repl.section).toBe("current");
    // Rendered lineage present.
    const md = render(state, false);
    expect(md).toContain("Training for a marathon → Marathon is off — sprained ankle");
  });

  test("core revision defers to the ledger, then accommodates past the threshold", () => {
    const state = seeded();
    const core = state.items.find((i) => i.section === "core")!;
    // Single mild proposal: deferred (0.4 * 0.9 * 0.75 = 0.27).
    const r1 = applyOps(
      state,
      [{ op: "supersede", targetId: core.id, text: "Has become conflict-avoidant", salience: 0.9, surprise: "mild" }],
      2,
      D2,
    );
    expect(r1.outcomes[0].outcome).toBe("deferred");
    expect(core.status).toBe("active");
    // Strong high-salience proposal pushes the accumulated total past 1.0
    // (0.27 + 1.0*1.0*0.75 = 1.02) → accommodated.
    const r2 = applyOps(
      state,
      [{ op: "supersede", targetId: core.id, text: "Has become conflict-avoidant", salience: 1.0, surprise: "strong" }],
      3,
      D3,
    );
    expect(r2.outcomes[0].outcome).toBe("accommodated");
    expect(core.status).toBe("superseded");
    expect(state.ledger[core.id].total).toBe(0); // reset after restructuring
    const repl = state.items.find((i) => i.text === "Has become conflict-avoidant")!;
    expect(repl.section).toBe("core");
  });

  test("note_mismatch accumulates and can trigger a pending deferred revision", () => {
    const state = seeded();
    const belief = state.items.find((i) => i.section === "belief")!;
    // Deferred revision carries pending text (1.0 * 0.8 * 0.5(high conf) = 0.4).
    applyOps(
      state,
      [{ op: "supersede", targetId: belief.id, text: "Now decides by gut feel", salience: 0.8, surprise: "strong" }],
      2,
      D2,
    );
    expect(belief.status).toBe("active");
    // Two more strong mismatch notes (0.4 each) cross the threshold at 1.2.
    applyOps(state, [{ op: "note_mismatch", targetId: belief.id, note: "again", surprise: "strong", salience: 0.8 }], 3, D3);
    const r = applyOps(
      state,
      [{ op: "note_mismatch", targetId: belief.id, note: "and again", surprise: "strong", salience: 0.8 }],
      4,
      "2025-03-09",
    );
    expect(r.outcomes[0].outcome).toBe("accommodated");
    expect(belief.status).toBe("superseded");
    expect(state.items.find((i) => i.text === "Now decides by gut feel")).toBeDefined();
  });

  test("protected items are immutable", () => {
    const state = seeded();
    const sacred = state.items.find((i) => i.section === "protected")!;
    const before = sacred.text;
    const { outcomes } = applyOps(
      state,
      [{ op: "supersede", targetId: sacred.id, text: "flattened version", salience: 0.9, surprise: "strong" }],
      2,
      D2,
    );
    expect(outcomes[0].outcome).toBe("rejected");
    expect(sacred.status).toBe("active");
    expect(sacred.text).toBe(before);
  });

  test("resolve_thread closes with resolution in lineage; bad ops rejected not thrown", () => {
    const state = seeded();
    const thread = state.items.find((i) => i.section === "thread")!;
    const { outcomes } = applyOps(
      state,
      [
        { op: "resolve_thread", targetId: thread.id, text: "Visited Marcus in Denver" },
        { op: "reinforce", targetId: "nope-99" },
        { op: "add", section: "bogus" as never, text: "x" },
        { op: "frobnicate" } as unknown as Op,
      ],
      2,
      D2,
    );
    expect(outcomes.map((o) => o.outcome)).toEqual(["applied", "rejected", "rejected", "rejected"]);
    expect(thread.status).toBe("superseded");
    expect(render(state, false)).toContain("Visited Marcus in Denver");
  });

  test("untouched items render byte-identically across cycles", () => {
    const state = seeded();
    const before = render(state, false);
    applyOps(state, [{ op: "note_mismatch", section: "core", note: "hm", surprise: "mild", salience: 0.3 }], 2, D2);
    expect(render(state, false)).toBe(before); // ledger-only ops don't change the projection
  });

  test("threshold constant sanity", () => {
    expect(ACCOMMODATE_THRESHOLD).toBe(1.0);
  });
});

describe("scanFabricatedDates", () => {
  const stated = ["february 3", "march 14", "july 12"];
  const sessions = ["2025-02-03", "2025-04-14"];

  test("flags unstated ISO and english dates; allows stated ones and month-year", () => {
    const proj = [
      "Sprained her ankle on 2025-04-12.", // fabricated ISO
      "The hike was on March 14, at Beacon Rock.", // stated
      "Session on 2025-04-14 covered it.", // session date
      "Marathon planned for October 2025.", // month-year, no day
      "Orthopedist visit April 17.", // fabricated english
      "Trip was July 12.", // stated
    ].join(" ");
    const r = scanFabricatedDates(proj, stated, sessions);
    expect(r.fabricated).toEqual(["2025-04-12", "april 17"]);
  });

  test("wrong-year date is fabricated even if month-day is stated", () => {
    const r = scanFabricatedDates("It happened March 14, 2024.", stated, sessions);
    expect(r.fabricated).toEqual(["march 14, 2024"]);
  });

  test("clean projection scans clean", () => {
    const r = scanFabricatedDates("She said it was a Saturday shortly before 2025-04-14.", stated, sessions);
    expect(r.count).toBe(0);
  });
});
