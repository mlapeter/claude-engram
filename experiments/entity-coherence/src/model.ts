// Policy C — the conservative assimilation mechanism from the 2026-07-15 design
// (research/memory-architecture-design.md §4). The maintainer model NEVER rewrites
// the entity model; it proposes structured ops, and this module applies them
// deterministically:
//   - assimilate by default (add dated instance / reinforce — no text changes)
//   - current-state/relationship/thread facts supersede immediately on a direct
//     statement (per-kind physics: facts supersede on one authoritative signal)
//   - core/belief revisions are DEFERRED to a surprise ledger and applied only past
//     an accumulated threshold weighted by salience + inverse confidence
//     ("one odd act doesn't change your model of a friend; a pattern does")
//   - protected items are immutable once written (sacred-verbatim, mechanized)
//   - nothing is ever deleted; superseded items keep lineage
// The threshold is a v1 flattening of the design's "continuous plasticity" gradient —
// acknowledged, tunable via the constants below.

export type Section = "core" | "current" | "relationship" | "thread" | "belief" | "protected";
export type Confidence = "low" | "medium" | "high";
export type Surprise = "none" | "low" | "mild" | "strong";

export type Item = {
  id: string;
  section: Section;
  text: string;
  date: string; // session date the item was written (or last superseded-into)
  entity?: string; // relationship items: who the bond is with
  confidence?: Confidence; // belief items
  reinforcedBy: string[]; // session dates that re-confirmed this item
  status: "active" | "superseded" | "archived";
  supersededBy?: { text: string; date: string }; // set when status flips
  // --- Hygiene / referential-integrity lineage (run 3 ops-gated compaction; contracts-v1 §1) ---
  mergedInto?: string; // gist.merge: this source's successor id (source archived, resolvable)
  derivedFrom?: string[]; // gist.merge: the source ids a gist successor was built from
  aliases?: string[]; // alias.add/remove ops
  compressedFrom?: string; // prose.compress: the pre-compression text (meaning-preserving audit)
  archivedReason?: string; // demote/merge: why this node left the active render (still resolvable in state)
  archivedAt?: string; // session date the node was archived at hygiene
};

export type LedgerEntry = {
  cycle: number;
  date: string;
  surprise: Surprise;
  salience: number;
  weight: number;
  note: string;
  proposedText?: string; // latest deferred revision text, if the op carried one
};

export type LedgerBucket = { entries: LedgerEntry[]; total: number };

export type ModelState = {
  items: Item[];
  ledger: Record<string, LedgerBucket>; // key = targetId or "section:<name>"
  nextId: number;
};

export type Op =
  | { op: "add"; section: Section; text: string; salience?: number; surprise?: Surprise; entity?: string; confidence?: Confidence }
  | { op: "reinforce"; targetId: string }
  | { op: "supersede"; targetId: string; text: string; salience?: number; surprise?: Surprise }
  | { op: "resolve_thread"; targetId: string; text: string }
  | { op: "note_mismatch"; targetId?: string; section?: Section; note: string; surprise: Surprise; salience?: number };

export type OpOutcome = {
  op: Op;
  outcome: "applied" | "deferred" | "accommodated" | "rejected" | "deduped";
  detail: string;
};

// --- Tunable physics ---
export const SURPRISE_WEIGHT: Record<Surprise, number> = { none: 0, low: 0.15, mild: 0.4, strong: 1.0 };
// Inverse-confidence factor: firmly-held beliefs resist accommodation.
export const CONFIDENCE_FACTOR: Record<Confidence, number> = { low: 1.0, medium: 0.75, high: 0.5 };
export const DEFAULT_SALIENCE = 0.5;
export const ACCOMMODATE_THRESHOLD = 1.0;

const SECTIONS: Section[] = ["core", "current", "relationship", "thread", "belief", "protected"];

export function emptyState(): ModelState {
  return { items: [], ledger: {}, nextId: 1 };
}

const ID_PREFIX: Record<Section, string> = {
  core: "core",
  current: "cs",
  relationship: "rel",
  thread: "th",
  belief: "bel",
  protected: "sal",
};

function mintId(state: ModelState, section: Section): string {
  return `${ID_PREFIX[section]}-${state.nextId++}`;
}

function findItem(state: ModelState, id: string): Item | undefined {
  return state.items.find((i) => i.id === id);
}

function clampSalience(v: number | undefined): number {
  if (typeof v !== "number" || Number.isNaN(v)) return DEFAULT_SALIENCE;
  return Math.min(1, Math.max(0, v));
}

function ledgerBucket(state: ModelState, key: string): LedgerBucket {
  if (!state.ledger[key]) state.ledger[key] = { entries: [], total: 0 };
  return state.ledger[key];
}

function accumulate(
  state: ModelState,
  key: string,
  cycle: number,
  date: string,
  surprise: Surprise,
  salience: number,
  confidence: Confidence | undefined,
  note: string,
  proposedText?: string,
): number {
  const weight =
    SURPRISE_WEIGHT[surprise] * salience * CONFIDENCE_FACTOR[confidence ?? "medium"];
  const bucket = ledgerBucket(state, key);
  bucket.entries.push({ cycle, date, surprise, salience, weight, note, proposedText });
  bucket.total += weight;
  return bucket.total;
}

// Latest deferred revision text in a bucket, if any op ever carried one.
function pendingText(bucket: LedgerBucket): string | undefined {
  for (let i = bucket.entries.length - 1; i >= 0; i--) {
    const t = bucket.entries[i].proposedText;
    if (t) return t;
  }
  return undefined;
}

function supersedeItem(state: ModelState, item: Item, text: string, date: string, salience: number): Item {
  item.status = "superseded";
  item.supersededBy = { text, date };
  const replacement: Item = {
    id: mintId(state, item.section),
    section: item.section,
    text,
    date,
    entity: item.entity,
    confidence: item.confidence,
    reinforcedBy: [],
    status: "active",
  };
  state.items.push(replacement);
  void salience; // salience recorded via the op log; replacement text is kept verbatim
  return replacement;
}

// Apply one cycle's proposed ops to the state, in order. Mutates and returns state
// plus a per-op outcome log. Never throws on a bad op — rejects and logs instead
// (a malformed proposal must not kill a 12-cycle run; rejects are audited).
export function applyOps(
  state: ModelState,
  ops: Op[],
  cycle: number,
  date: string,
  threshold: number = ACCOMMODATE_THRESHOLD, // run 2 uses the 1.0 default; run 3 passes the Phase-0 default (3.0)
): { state: ModelState; outcomes: OpOutcome[] } {
  const outcomes: OpOutcome[] = [];
  const log = (op: Op, outcome: OpOutcome["outcome"], detail: string) =>
    outcomes.push({ op, outcome, detail });

  for (const op of ops) {
    switch (op.op) {
      case "add": {
        if (!SECTIONS.includes(op.section)) {
          log(op, "rejected", `unknown section "${op.section}"`);
          break;
        }
        if (!op.text || !op.text.trim()) {
          log(op, "rejected", "empty text");
          break;
        }
        const dup = state.items.find(
          (i) => i.section === op.section && i.status === "active" && i.text.trim() === op.text.trim(),
        );
        if (dup) {
          if (!dup.reinforcedBy.includes(date)) dup.reinforcedBy.push(date);
          log(op, "deduped", `identical active item ${dup.id}; treated as reinforce`);
          break;
        }
        const item: Item = {
          id: mintId(state, op.section),
          section: op.section,
          text: op.text.trim(),
          date,
          entity: op.entity,
          confidence: op.section === "belief" ? (op.confidence ?? "medium") : undefined,
          reinforcedBy: [],
          status: "active",
        };
        state.items.push(item);
        log(op, "applied", `added ${item.id}`);
        break;
      }

      case "reinforce": {
        const item = findItem(state, op.targetId);
        if (!item) {
          log(op, "rejected", `no item ${op.targetId}`);
          break;
        }
        if (item.status === "superseded") {
          log(op, "rejected", `${op.targetId} is superseded`);
          break;
        }
        if (!item.reinforcedBy.includes(date)) item.reinforcedBy.push(date);
        log(op, "applied", `reinforced ${item.id}`);
        break;
      }

      case "supersede": {
        const item = findItem(state, op.targetId);
        if (!item) {
          log(op, "rejected", `no item ${op.targetId}`);
          break;
        }
        if (!op.text || !op.text.trim()) {
          log(op, "rejected", "empty replacement text");
          break;
        }
        if (item.section === "protected") {
          log(op, "rejected", "protected items are immutable"); // sacred-verbatim guard
          break;
        }
        if (item.status === "superseded") {
          log(op, "rejected", `${op.targetId} already superseded`);
          break;
        }
        const salience = clampSalience(op.salience);
        if (item.section === "core" || item.section === "belief") {
          // High-inertia sections: defer to the surprise ledger.
          const total = accumulate(
            state,
            item.id,
            cycle,
            date,
            op.surprise ?? "mild",
            salience,
            item.confidence,
            `proposed revision of ${item.id}`,
            op.text.trim(),
          );
          if (total >= threshold) {
            const repl = supersedeItem(state, item, op.text.trim(), date, salience);
            state.ledger[item.id].total = 0; // reset after restructuring
            log(op, "accommodated", `ledger ${total.toFixed(2)} >= ${threshold}; ${item.id} -> ${repl.id}`);
          } else {
            log(op, "deferred", `ledger ${total.toFixed(2)} < ${threshold} on ${item.id}`);
          }
          break;
        }
        // Fast-changing sections supersede immediately on a direct statement.
        const repl = supersedeItem(state, item, op.text.trim(), date, salience);
        log(op, "applied", `${item.id} -> ${repl.id}`);
        break;
      }

      case "resolve_thread": {
        const item = findItem(state, op.targetId);
        if (!item) {
          log(op, "rejected", `no item ${op.targetId}`);
          break;
        }
        if (item.section !== "thread") {
          log(op, "rejected", `${op.targetId} is not a thread`);
          break;
        }
        if (item.status === "superseded") {
          log(op, "rejected", `${op.targetId} already resolved`);
          break;
        }
        item.status = "superseded";
        item.supersededBy = { text: op.text?.trim() || "resolved", date };
        log(op, "applied", `resolved ${item.id}`);
        break;
      }

      case "note_mismatch": {
        const key = op.targetId
          ? findItem(state, op.targetId)?.id ?? `section:${op.section ?? "unknown"}`
          : `section:${op.section ?? "unknown"}`;
        const target = op.targetId ? findItem(state, op.targetId) : undefined;
        const total = accumulate(
          state,
          key,
          cycle,
          date,
          op.surprise,
          clampSalience(op.salience),
          target?.confidence,
          op.note ?? "",
        );
        // A mismatch note alone never restructures; but if earlier deferred revisions
        // left a pending text and the ledger now crosses, apply that revision.
        if (target && (target.section === "core" || target.section === "belief") && target.status === "active" && total >= threshold) {
          const text = pendingText(state.ledger[key]);
          if (text) {
            const repl = supersedeItem(state, target, text, date, clampSalience(op.salience));
            state.ledger[key].total = 0;
            log(op, "accommodated", `ledger ${total.toFixed(2)} crossed with pending revision; ${target.id} -> ${repl.id}`);
            break;
          }
        }
        log(op, "deferred", `ledger ${key} now ${total.toFixed(2)}`);
        break;
      }

      default:
        log(op, "rejected", `unknown op "${(op as { op?: string }).op}"`);
    }
  }
  return { state, outcomes };
}

// --- Ledger instrumentation (run 3): flat per-bucket snapshot for the trajectory ---
export type LedgerSnapshotRow = {
  key: string; // targetId or "section:<name>"
  targetText?: string; // the active item the bucket is accumulating against, if resolvable
  targetSection?: Section;
  total: number;
  entries: number;
  hasPendingRevision: boolean;
};

export function ledgerSnapshot(state: ModelState): LedgerSnapshotRow[] {
  const rows: LedgerSnapshotRow[] = [];
  for (const [key, bucket] of Object.entries(state.ledger)) {
    const target = state.items.find((i) => i.id === key);
    rows.push({
      key,
      targetText: target?.text,
      targetSection: target?.section,
      total: bucket.total,
      entries: bucket.entries.length,
      hasPendingRevision: bucket.entries.some((e) => !!e.proposedText),
    });
  }
  rows.sort((a, b) => b.total - a.total);
  return rows;
}

// --- Rendering ---

function fmtItem(item: Item, withId: boolean): string {
  const id = withId ? `[${item.id}] ` : "";
  const reinforced = item.reinforcedBy.length > 0 ? `; reinforced ${item.reinforcedBy.join(", ")}` : "";
  switch (item.section) {
    case "core":
      return `- ${id}${item.text} (since ${item.date}${reinforced})`;
    case "current":
      return `- ${id}[as of ${item.date}] ${item.text}`;
    case "relationship":
      return `- ${id}${item.entity ? `${item.entity}: ` : ""}${item.text} (as of ${item.date}${reinforced})`;
    case "thread":
      return `- ${id}${item.text} (opened ${item.date}${reinforced})`;
    case "belief":
      return `- ${id}${item.text} — source ${item.date} — confidence ${item.confidence ?? "medium"} — [status: active]`;
    case "protected":
      return `- ${id}${item.text} (${item.date})`;
  }
}

const SECTION_HEADINGS: [Section, string][] = [
  ["core", "## Stable core"],
  ["current", "## Current state"],
  ["relationship", "## Relationships"],
  ["thread", "## Open threads / debts"],
  ["belief", "## Beliefs & preferences"],
];

// Render the structured state to the schema Markdown. `withIds` = true for the
// maintainer's input (ops reference ids); false for the projection probes see.
export function render(state: ModelState, withIds: boolean): string {
  const out: string[] = ["# Entity: Dana Whitfield  (kind: person)", ""];
  for (const [section, heading] of SECTION_HEADINGS) {
    out.push(heading, "");
    const items = state.items.filter((i) => i.section === section && i.status === "active");
    if (items.length === 0) out.push("(none yet)");
    else for (const i of items) out.push(fmtItem(i, withIds));
    out.push("");
  }

  out.push("## Superseded (kept, never deleted)", "");
  const superseded = state.items.filter((i) => i.status === "superseded");
  if (superseded.length === 0) out.push("(none yet)");
  else {
    for (const i of superseded) {
      const id = withIds ? `[${i.id}] ` : "";
      out.push(`- ${id}${i.text} → ${i.supersededBy!.text}, ${i.supersededBy!.date}.`);
    }
  }
  out.push("");

  out.push("## Salient / protected", "");
  const sacred = state.items.filter((i) => i.section === "protected" && i.status === "active");
  if (sacred.length === 0) out.push("(none yet)");
  else for (const i of sacred) out.push(fmtItem(i, withIds));
  out.push("");

  return out.join("\n");
}
