// Ops-gated compaction — run 3 hygiene (design revision #1; contracts-v1 §1).
// Replaces the v1.0 "re-derive-with-pins" fresh pass. Runs every hygiene.everyNCycles
// (cycles 8, 16, 24 for this run). The maintainer proposes a restricted vocabulary of
// COMPACTION ops; this engine applies them deterministically and REFUSES — in code, not by
// instruction — any op that:
//   (a) targets a PINNED id (protected/sacred-verbatim items, or an item that is the target of
//       an OPEN surprise-ledger bucket — "ledger evidence is auto-pinned while the entry is open"
//       so hygiene cannot eat slow-burn accommodation evidence before it crosses threshold), or
//   (b) is not one of the compaction ops (i.e., any attempt to add/supersede/note/re-judge a
//       node = a fresh derivation, which runs 1-2 both incriminated — "never a fresh derivation").
// Nothing is destroyed: merge sources and demoted nodes are ARCHIVED (state, not deletion —
// id kept, content + reason retained, resolvable), only absent from the active render.

import type { Item, ModelState, Section } from "./model.ts";

export type HygieneOp =
  | { op: "gist.merge"; targetIds: string[]; text: string; section?: Section; reason?: string }
  | { op: "demote"; targetId: string; reason?: string }
  | { op: "prose.compress"; targetId: string; text: string }
  | { op: "alias.add"; targetId: string; alias: string }
  | { op: "alias.remove"; targetId: string; alias: string; reason?: string };

export type HygieneOutcome = {
  op: HygieneOp | { op?: string };
  outcome: "applied" | "rejected" | "deduped";
  detail: string;
};

const COMPACTION_OPS = new Set(["gist.merge", "demote", "prose.compress", "alias.add", "alias.remove"]);

// Auto-pin set: protected (sacred-verbatim, always immutable) ∪ the target items of OPEN ledger
// buckets (accommodation evidence — uncompactable while the ledger entry is open). Mechanized.
export function computePinnedIds(state: ModelState): Set<string> {
  const pinned = new Set<string>();
  for (const i of state.items) {
    if (i.section === "protected" && i.status !== "archived") pinned.add(i.id);
  }
  for (const [key, bucket] of Object.entries(state.ledger)) {
    if (bucket.total > 0 && state.items.some((i) => i.id === key)) pinned.add(key); // open-ledger target
  }
  return pinned;
}

function mintGistId(state: ModelState): string {
  return `gist-${state.nextId++}`;
}

// Apply one hygiene pass. Mutates state; returns a per-op outcome log. Never throws on a bad op.
export function applyHygieneOps(
  state: ModelState,
  ops: HygieneOp[],
  date: string,
  pinned: Set<string>,
): { state: ModelState; outcomes: HygieneOutcome[] } {
  const outcomes: HygieneOutcome[] = [];
  const log = (op: HygieneOp | { op?: string }, outcome: HygieneOutcome["outcome"], detail: string) =>
    outcomes.push({ op, outcome, detail });
  const find = (id: string) => state.items.find((i) => i.id === id);

  for (const raw of ops) {
    const opName = (raw as { op?: string }).op;

    // Guard (b): only compaction ops. Any other op = an attempt to derive/re-judge a node.
    if (!opName || !COMPACTION_OPS.has(opName)) {
      log(raw, "rejected", `"${opName}" is not a compaction op — hygiene never derives or re-judges nodes`);
      continue;
    }

    const op = raw as HygieneOp;
    switch (op.op) {
      case "gist.merge": {
        if (!Array.isArray(op.targetIds) || op.targetIds.length < 2) {
          log(op, "rejected", "gist.merge needs >= 2 source ids");
          break;
        }
        const sources = op.targetIds.map(find);
        if (sources.some((s) => !s)) {
          log(op, "rejected", `unknown source id in ${JSON.stringify(op.targetIds)}`);
          break;
        }
        const items = sources as Item[];
        // Guard (a): no pinned source may be compacted.
        const pinnedHit = items.find((s) => pinned.has(s.id));
        if (pinnedHit) {
          log(op, "rejected", `source ${pinnedHit.id} is pinned (protected or open-ledger evidence)`);
          break;
        }
        if (items.some((s) => s.status !== "active")) {
          log(op, "rejected", "all merge sources must be active");
          break;
        }
        const sections = new Set(items.map((s) => s.section));
        if (sections.size > 1) {
          log(op, "rejected", "gist.merge sources must share one section");
          break;
        }
        if (items.some((s) => s.section === "protected")) {
          log(op, "rejected", "protected items cannot be merged");
          break;
        }
        if (!op.text || !op.text.trim()) {
          log(op, "rejected", "empty gist text");
          break;
        }
        const section = items[0].section;
        const successorId = mintGistId(state);
        const successor: Item = {
          id: successorId,
          section,
          text: op.text.trim(),
          date,
          entity: items[0].entity,
          confidence: items[0].confidence,
          reinforcedBy: [],
          status: "active",
          derivedFrom: items.map((s) => s.id),
        };
        for (const s of items) {
          s.status = "archived";
          s.mergedInto = successorId;
          s.archivedReason = op.reason?.trim() || `merged into ${successorId}`;
          s.archivedAt = date;
        }
        state.items.push(successor);
        log(op, "applied", `merged ${op.targetIds.join("+")} -> ${successorId} (sources archived, linked)`);
        break;
      }

      case "demote": {
        const item = find(op.targetId);
        if (!item) {
          log(op, "rejected", `no item ${op.targetId}`);
          break;
        }
        if (pinned.has(item.id)) {
          log(op, "rejected", `${item.id} is pinned (protected or open-ledger evidence)`);
          break;
        }
        if (item.status === "archived") {
          log(op, "rejected", `${item.id} already archived`);
          break;
        }
        item.status = "archived";
        item.archivedReason = op.reason?.trim() || "demoted out of active render (resolvable in state)";
        item.archivedAt = date;
        log(op, "applied", `demoted ${item.id} (archived, resolvable)`);
        break;
      }

      case "prose.compress": {
        const item = find(op.targetId);
        if (!item) {
          log(op, "rejected", `no item ${op.targetId}`);
          break;
        }
        if (pinned.has(item.id)) {
          log(op, "rejected", `${item.id} is pinned (protected or open-ledger evidence)`);
          break;
        }
        if (item.status !== "active") {
          log(op, "rejected", `${item.id} is not active`);
          break;
        }
        if (!op.text || !op.text.trim()) {
          log(op, "rejected", "empty compressed text");
          break;
        }
        if (op.text.trim().length >= item.text.length) {
          log(op, "rejected", "prose.compress must shorten (not expand or re-derive) the text");
          break;
        }
        item.compressedFrom = item.text;
        item.text = op.text.trim();
        log(op, "applied", `compressed ${item.id} (${item.compressedFrom.length} -> ${item.text.length} chars)`);
        break;
      }

      case "alias.add": {
        const item = find(op.targetId);
        if (!item) {
          log(op, "rejected", `no item ${op.targetId}`);
          break;
        }
        if (pinned.has(item.id)) {
          log(op, "rejected", `${item.id} is pinned`);
          break;
        }
        if (!op.alias || !op.alias.trim()) {
          log(op, "rejected", "empty alias");
          break;
        }
        item.aliases ??= [];
        if (item.aliases.includes(op.alias.trim())) {
          log(op, "deduped", `alias "${op.alias}" already on ${item.id}`);
          break;
        }
        item.aliases.push(op.alias.trim());
        log(op, "applied", `alias "${op.alias}" -> ${item.id}`);
        break;
      }

      case "alias.remove": {
        const item = find(op.targetId);
        if (!item) {
          log(op, "rejected", `no item ${op.targetId}`);
          break;
        }
        if (pinned.has(item.id)) {
          log(op, "rejected", `${item.id} is pinned`);
          break;
        }
        if (!op.reason || !op.reason.trim()) {
          log(op, "rejected", "alias.remove requires a reason (explicit op, contracts §5)");
          break;
        }
        const idx = item.aliases?.indexOf(op.alias?.trim() ?? "") ?? -1;
        if (idx < 0) {
          log(op, "rejected", `alias "${op.alias}" not present on ${item.id}`);
          break;
        }
        item.aliases!.splice(idx, 1);
        log(op, "applied", `removed alias "${op.alias}" from ${item.id} (${op.reason.trim()})`);
        break;
      }

      default:
        log(op, "rejected", `unhandled compaction op`);
    }
  }
  return { state, outcomes };
}

// --- Hygiene prompt. Deliberately does NOT enumerate the pinned items: the engine enforces the
// pins, so leaving the maintainer free to propose compacting them is what makes the auto-pin /
// sacred-verbatim guard OBSERVABLE (rejections in the ops log = the guard doing its job). ---

export const HYGIENE_SYSTEM = `You are the hygiene step of a memory system maintaining a structured entity model of one
person, Dana Whitfield. The model has grown over many sessions and needs COMPACTION so it
stays bounded and readable. You do NOT rewrite the model and you do NOT re-judge what things
mean. You propose a minimal set of COMPACTION operations as JSON; a deterministic engine
applies them.

Your only goal is to reduce size while preserving ALL meaning and ALL lineage. Good targets:
redundant or superseded material (e.g. a chain of "jogging up to N minutes" updates, or old
current-state items that a newer item already supersedes), and verbose text that can be said
more briefly without losing information.

Available operations (output as a JSON object {"ops": [...]}):
- {"op":"gist.merge","targetIds":["id1","id2",...],"text":"<one concise node capturing all of them>","reason":"..."} — collapse >= 2 active items in the SAME section into one gist; the sources are archived and linked (kept, resolvable), never deleted.
- {"op":"demote","targetId":"<id>","reason":"..."} — move a stale/superseded item out of the active view; it is archived (kept, resolvable), not deleted.
- {"op":"prose.compress","targetId":"<id>","text":"<shorter text, SAME meaning>"} — shorten one item's wording. Must be shorter and must not change meaning or drop specifics.
- {"op":"alias.add","targetId":"<id>","alias":"<name>"} / {"op":"alias.remove","targetId":"<id>","alias":"<name>","reason":"..."} — manage entity aliases.

Rules:
- NEVER invent, re-judge, or rewrite the MEANING of anything. Compaction only. No new facts.
- Preserve lineage: superseded history and emotionally significant specifics must remain
  recoverable. When in doubt, do less.
- Output ONLY the JSON object {"ops":[...]}. Proposing few ops is fine.`;

export function hygieneUserPrompt(modelWithIds: string, date: string): string {
  return `Here is the current entity model of Dana Whitfield (item ids in brackets). Session date: ${date}.

<entity_model>
${modelWithIds}
</entity_model>

Propose the compaction operations as {"ops": [...]}.`;
}

export const HYGIENE_MAX_TOKENS = 3000;
