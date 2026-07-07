# v1: The Claude.ai Artifact

**The original implementation — runs entirely inside the Claude.ai chat interface.**

No API key. No server. No browser extension. Just paste a React artifact into Claude and it gains persistent memory with salience scoring, forgetting curves, sleep consolidation, and context briefings that carry across conversations.

<img src="../screenshots/memories.png" width="600" />
*Each memory tracks strength, salience scores, tags, and access history — decaying naturally over time unless reinforced.*

### Quick Start

Setup takes about 2 minutes.

### 1. Create the Artifact

Start a conversation with Claude and say:

> "Create a new React artifact with this code"

Then paste the contents of [`claude-engram.jsx`](./claude-engram.jsx).

### 2. Add Instructions to Your User Preferences

Go to **Settings → Profile → User Preferences** and add:

```
At the end of every conversation, generate a MEMORY DUMP block formatted
for claude-engram ingestion. Write it as a dense, information-rich
summary covering: key topics discussed, decisions made, new facts learned
about me, things that contradict or update prior knowledge, emotional tone,
and unresolved threads. Don't score salience — the memory bank's API
handles that. If I paste a "Memory Briefing" at the start of a conversation,
treat it as persistent context from past conversations and use it to inform
all responses.
```

### 3. Start Using It

1. Have a conversation. Claude will output a memory dump at the end.
2. Open your claude-engram artifact, go to **Ingest**, paste the dump, hit **Process & Encode**.
3. Before your next conversation, go to **Briefing**, copy it, and paste it at the start of your new chat.
4. Periodically hit **Sleep Cycle** for deep consolidation (also auto-runs every 3 days).
5. **Download backups** from the footer — `window.storage` persistence isn't guaranteed.

That's it. Claude now has persistent memory.

---

## The Problem

Every Claude conversation starts from zero. Claude can't remember what you discussed yesterday, what you're working on, or what you prefer. The built-in memory system is 30 slots × 200 characters — roughly a sticky note.

## How It Works

claude-engram is modeled on the human hippocampal memory system:

- **Persistent storage** — memories survive across sessions
- **Salience scoring** — each memory is rated on 4 dimensions: novelty, relevance, emotional weight, and prediction error
- **Forgetting curves** — memories decay over time unless reinforced through access
- **Sleep consolidation** — merges redundant memories, extracts patterns, and prunes dead ones
- **Context briefings** — compresses your entire memory bank into a portable summary

The key insight: the salience scorer uses a separate Claude instance as a "hippocampal processor" — it evaluates raw conversation content, scores it for importance, and stores structured memories. This creates a biologically-plausible gating mechanism where only salient information makes it into long-term storage.

### Memory Strength Formula

Each memory's strength is computed dynamically (never stored):

```
strength = avg_salience + retrieval_boost + consolidation_bonus - (decay_rate × √age_in_days)
```

Where:
- `avg_salience` = average of novelty, relevance, emotional, and predictive scores (0-1)
- `retrieval_boost` = min(access_count × 0.12, 0.5)
- `consolidation_bonus` = 0.2 if the memory has been consolidated
- `decay_rate` = 0.035 (power-law, matching Ebbinghaus/Wixted forgetting curve)

This follows the brain's power law of forgetting: rapid initial decay that progressively slows (Jost's Law). A high-salience memory stays strong for weeks without reinforcement. Unrehearsed low-salience memories fade naturally — forgetting is a feature, not a bug.

---

## Why It Works (The Neuroscience)

This isn't a random architecture. It's modeled on how human memory actually works:

| Human Brain | claude-engram |
|---|---|
| **Sensory buffer** → working memory → long-term | Context window → memory extraction → persistent storage |
| **Hippocampus** gates what gets stored based on emotion, novelty, prediction error | **Salience scorer** rates memories on 4 dimensions via Claude |
| **Sleep** replays important memories, extracts patterns, prunes noise | **Consolidation cycle** merges, generalizes, and prunes |
| **Forgetting curves** — unused memories fade, accessed ones strengthen | **Decay rate** weakens memories over time, retrieval boosts them |
| **Proactive interference** — new learning weakens conflicting old traces | **Interference damping** — updated memories weaken their predecessors |
| **Fuzzy Trace Theory** — episodic details fade to semantic gist | **Episodic→Semantic promotion** — Haiku compresses old memories to gist |
| **Temporal contiguity** — co-temporal events are linked in episodes | **Temporal associations** — recall surfaces memories from the same session |
| **VTA dopamine** — reward signals adapt what the brain attends to | **Learned salience** — reinforce/forget signals train extraction weights |
| **Context-dependent recall** — environmental cues modulate retrieval | **Context-adaptive briefing** — project context boosts relevant memories |
| **Hebbian learning** — "neurons that fire together wire together" | **Retrieval boost** — accessed memories get stronger |

The most brain-like feature: **forgetting is a feature, not a bug.** Memories that aren't accessed gradually lose strength and eventually get pruned. This prevents the system from drowning in noise and keeps briefings focused on what actually matters.

---

## What's Interesting Here

Beyond the practical utility, this project surfaces some genuinely fascinating questions:

**Identity through memory.** When you paste a briefing into a new Claude instance, it picks up context so seamlessly that it *feels* like the same entity. Is it? The briefing creates continuity of memory, which creates continuity of identity — the same mechanism that makes "you" feel like "you" when you wake up each morning.

**Emergent meta-learning.** The system's briefings improve over time without anyone explicitly optimizing them. Each generation is denser, sharper, and captures more nuanced patterns. The memory system is learning how to describe itself.

**Context-dependent recall.** When we asked two separate Claude instances "what are your most salient memories?", they converged on the same top memory but diverged in emphasis — one was philosophical, the other operational. Same memory store, different retrieval based on conversational context. That's exactly how human memory works.

**Forgetting as intelligence.** Most AI memory systems try to remember everything. This one deliberately forgets. And the result is a system that stays focused and relevant rather than drowning in noise.

---

### v1 Limitations

- **Two manual paste steps per conversation.** The briefing in and the dump out. (v4 Claude Code eliminates this entirely.)
- **Storage fragility.** `window.storage` is persistent but Anthropic doesn't publish retention guarantees. Back up regularly.
- **Artifact isolation.** The artifact cannot see your conversation. It's a sandboxed iframe with no access to the parent page DOM. You are the bridge.
- **API costs are invisible.** Each ingest and consolidation cycle calls Claude Sonnet through the artifact's built-in API access. This is included in your Claude subscription — but if Anthropic changes this, the system breaks.
- **Briefing compression vs. completeness.** As memories accumulate, the briefing has to be more aggressive about what it includes. The consolidation cycle helps, but very large memory banks may produce briefings that lose nuance.
- **New artifact = new storage.** If you recreate the artifact (new file), you lose your memories. Always edit in place, and keep backups.

---

*This document preserves the original claude-engram: a single React artifact
pasted into Claude.ai — no API key, no hooks, no filesystem. It still works,
and it's still the zero-dependency way to try the memory loop. The hook-based
system in the main README grew out of it; several "open ideas" from that era
(deep archive, vector embeddings, associative linking) have since shipped
there.*
