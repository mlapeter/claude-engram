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
  // --- Accommodation-iteration (run 3c) — rule-2 belief minting + rule-1 rerouting lineage ---
  identityBelief?: boolean; // belief: minted deterministically from an identity claim (rule 2)
  mintedFrom?: string; // belief: the source (protected/claim) item id it was minted from
  identityBeliefId?: string; // source item: the belief minted from it (rule-1 reroute target)
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
  | { op: "add"; section: Section; text: string; salience?: number; surprise?: Surprise; entity?: string; confidence?: Confidence; identityClaim?: boolean }
  | { op: "reinforce"; targetId: string }
  | { op: "supersede"; targetId: string; text: string; salience?: number; surprise?: Surprise }
  | { op: "resolve_thread"; targetId: string; text: string }
  | { op: "note_mismatch"; targetId?: string; section?: Section; note: string; surprise: Surprise; salience?: number };

export type OpOutcome = {
  op: Op;
  outcome: "applied" | "deferred" | "accommodated" | "rejected" | "deduped" | "minted" | "rerouted";
  detail: string;
};

/**
 * The four accommodation-iteration rules (run 3c), OFF by default so run 2/3/3b
 * behavior is byte-identical (no opts = the pre-iteration engine). When provided,
 * they make the ledger's accommodation half safe per the 2026-07-17 spec.
 */
export type AccommodationOptions = {
  /** Rule 3 — a single event contributes at most `perEventCapFraction × threshold`. */
  perEventCapFraction?: number;
  /** Rule 4 — core/belief accommodation also needs ≥ this many distinct sessions. */
  minDistinctSessions?: number;
  /** Rule 1 — protected items are never ledger targets; evidence reroutes to the
   *  minted identity belief (or is refused + logged). */
  protectedExclusion?: boolean;
  /** Rule 2 — an add flagged identityClaim (salience ≥ 0.6) mints a live belief. */
  mintIdentityBeliefs?: boolean;
};

const IDENTITY_CLAIM_MIN_SALIENCE = 0.6;
const IDENTITY_BELIEF_DUPE_SIM = 0.5;

/** Distinct sessions (dates) an accommodation bucket's evidence spans (rule 4). */
export function distinctSessions(bucket: LedgerBucket): number {
  return new Set(bucket.entries.map((e) => e.date)).size;
}

/** Deterministic lexical overlap (Jaccard over lowercased word tokens ≥ 4 chars). */
function lexicallySimilar(a: string, b: string, threshold: number): boolean {
  const toks = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 4),
    );
  const A = toks(a);
  const B = toks(b);
  if (A.size === 0 || B.size === 0) return false;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  const union = A.size + B.size - inter;
  return union > 0 && inter / union >= threshold;
}

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
  cap?: number, // rule 3 — per-event contribution ceiling (undefined = uncapped)
): number {
  const raw = SURPRISE_WEIGHT[surprise] * salience * CONFIDENCE_FACTOR[confidence ?? "medium"];
  const weight = cap !== undefined ? Math.min(raw, cap) : raw;
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

/**
 * Rule 2 — mint (or reuse) a live identity belief from an identity-claim add.
 * The engine mints it deterministically so contradiction evidence has a target
 * that exists by rule (fixing the run-3-vs-3b bucket instability). If the claim
 * was itself added as a belief, that belief IS the target (flag it). Idempotent
 * via a lexical semantic-dupe check against existing active beliefs.
 */
function mintIdentityBelief(state: ModelState, source: Item, salience: number, date: string): { minted?: Item; dupe?: Item } {
  if (source.section === "belief") {
    source.identityBelief = true;
    return { dupe: source };
  }
  const dupe = state.items.find((i) => i.section === "belief" && i.status === "active" && lexicallySimilar(i.text, source.text, IDENTITY_BELIEF_DUPE_SIM));
  if (dupe) {
    dupe.identityBelief = true;
    if (!source.identityBeliefId) source.identityBeliefId = dupe.id;
    return { dupe };
  }
  const belief: Item = {
    id: mintId(state, "belief"),
    section: "belief",
    text: source.text,
    date,
    confidence: salience >= 0.8 ? "high" : "medium",
    reinforcedBy: [],
    status: "active",
    identityBelief: true,
    mintedFrom: source.id,
  };
  state.items.push(belief);
  source.identityBeliefId = belief.id;
  return { minted: belief };
}

/** Rule 1 — the live identity belief a protected item's contradiction reroutes to. */
function rerouteProtected(state: ModelState, protectedItem: Item): Item | undefined {
  let bel = protectedItem.identityBeliefId ? findItem(state, protectedItem.identityBeliefId) : undefined;
  if (!bel || bel.status !== "active") {
    const actives = state.items.filter((i) => i.section === "belief" && i.status === "active" && i.identityBelief);
    bel = actives.length === 1 ? actives[0] : undefined;
  }
  return bel && bel.status === "active" ? bel : undefined;
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
  opts: AccommodationOptions = {}, // run 3c: the four rules (OFF by default → run 2/3/3b unchanged)
): { state: ModelState; outcomes: OpOutcome[] } {
  const outcomes: OpOutcome[] = [];
  const log = (op: Op, outcome: OpOutcome["outcome"], detail: string) =>
    outcomes.push({ op, outcome, detail });
  // Rule 3 — per-event cap (absolute), derived from the effective threshold.
  const cap = opts.perEventCapFraction !== undefined ? opts.perEventCapFraction * threshold : undefined;
  const minSessions = opts.minDistinctSessions ?? 1; // rule 4 — 1 = no occasions gate
  // Rule 4 gate for a core/belief bucket that has reached `threshold`.
  const occasionsMet = (key: string): boolean => distinctSessions(ledgerBucket(state, key)) >= minSessions;

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
        // Rule 2 — an identity claim (a self-report about a stable disposition)
        // deterministically mints a live belief, so contradiction evidence has a
        // target that exists by rule, not by the maintainer's whim. Idempotent.
        if (opts.mintIdentityBeliefs && op.identityClaim && clampSalience(op.salience) >= IDENTITY_CLAIM_MIN_SALIENCE) {
          const r = mintIdentityBelief(state, item, clampSalience(op.salience), date);
          if (r.minted) log(op, "minted", `minted identity belief ${r.minted.id} from ${item.id}`);
          else if (r.dupe) log(op, "deduped", `identity belief already stands in (${r.dupe.id})`);
        }
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
        let item = findItem(state, op.targetId);
        if (!item) {
          log(op, "rejected", `no item ${op.targetId}`);
          break;
        }
        if (!op.text || !op.text.trim()) {
          log(op, "rejected", "empty replacement text");
          break;
        }
        if (item.section === "protected") {
          // Rule 1 — a protected verbatim is never a ledger target. Reroute the
          // contradiction to the minted identity belief; refuse if none exists.
          if (opts.protectedExclusion) {
            const r = rerouteProtected(state, item);
            if (!r) {
              log(op, "rejected", `${op.targetId} is protected — no live belief to reroute to (refused-target)`);
              break;
            }
            log(op, "rerouted", `protected ${item.id} → belief ${r.id} (rule 1)`);
            item = r;
          } else {
            log(op, "rejected", "protected items are immutable"); // sacred-verbatim guard
            break;
          }
        }
        if (item.status === "superseded") {
          log(op, "rejected", `${op.targetId} already superseded`);
          break;
        }
        const salience = clampSalience(op.salience);
        if (item.section === "core" || item.section === "belief") {
          // High-inertia sections: defer to the surprise ledger (rule-3 capped).
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
            cap,
          );
          // Rule 4 — person/self identity needs the pattern, not one dramatic scene.
          if (total >= threshold && occasionsMet(item.id)) {
            const repl = supersedeItem(state, item, op.text.trim(), date, salience);
            state.ledger[item.id].total = 0; // reset after restructuring
            log(op, "accommodated", `ledger ${total.toFixed(2)} >= ${threshold} over ${distinctSessions(ledgerBucket(state, item.id))} sessions; ${item.id} -> ${repl.id}`);
          } else if (total >= threshold) {
            log(op, "deferred", `ledger ${total.toFixed(2)} >= ${threshold} but only ${distinctSessions(ledgerBucket(state, item.id))} distinct session(s) (need ${minSessions}) on ${item.id}`);
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
        let target = op.targetId ? findItem(state, op.targetId) : undefined;
        // Rule 1 — a protected verbatim is never a ledger target. Reroute the
        // contradiction to the minted identity belief; refuse if none exists.
        if (opts.protectedExclusion && target && target.section === "protected") {
          const r = rerouteProtected(state, target);
          if (!r) {
            log(op, "rejected", `${op.targetId} is protected — no live belief to reroute to (refused-target)`);
            break;
          }
          log(op, "rerouted", `protected ${target.id} → belief ${r.id} (rule 1)`);
          target = r;
        }
        const key = target ? target.id : op.targetId ? op.targetId : `section:${op.section ?? "unknown"}`;
        const total = accumulate(
          state,
          key,
          cycle,
          date,
          op.surprise,
          clampSalience(op.salience),
          target?.confidence,
          op.note ?? "",
          undefined,
          cap,
        );
        // A mismatch note alone never restructures; but if earlier deferred revisions
        // left a pending text and the ledger now crosses (rule-4 occasions met), apply it.
        if (target && (target.section === "core" || target.section === "belief") && target.status === "active" && total >= threshold && occasionsMet(key)) {
          const text = pendingText(state.ledger[key]);
          if (text) {
            const repl = supersedeItem(state, target, text, date, clampSalience(op.salience));
            state.ledger[key].total = 0;
            log(op, "accommodated", `ledger ${total.toFixed(2)} crossed over ${distinctSessions(ledgerBucket(state, key))} sessions with pending revision; ${target.id} -> ${repl.id}`);
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
  distinctSessions: number; // rule 4 — occasions the evidence spans
  identityBelief: boolean; // rule 2 — the accumulation target is a minted identity belief
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
      distinctSessions: distinctSessions(bucket),
      identityBelief: target?.identityBelief === true,
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
