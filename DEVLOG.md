# claude-engram Development Log

Changes and the reasoning behind them, especially brain-inspired features.

---

## 2026-03-01: 5 Brain-Inspired Memory Features

Five features that close gaps between our implementation and the biological blueprint.

### 1. Proactive Interference

**What:** When a new memory supersedes an old one (via `updated_from`), the old memory's salience dimensions are multiplied by 0.7 in real-time.

**Why (neuroscience):** Proactive interference — the brain actively weakens old conflicting traces when new information is encoded. Rather than waiting for sleep consolidation to resolve conflicts, the hippocampus begins inhibiting the competing trace immediately during encoding. Configurable via `interferenceFactor` in config.

**Files:** `src/core/interference.ts`, hooks (on-stop, on-session-end, on-pre-compact), `src/core/config.ts`

### 2. Episodic→Semantic Degradation (Fuzzy Trace Theory)

**What:** New `memory_type` field ("episodic" | "semantic"). During consolidation, episodic memories >7 days old are batch-compressed to semantic gist via Haiku. Merged and generalized memories are always semantic.

**Why (neuroscience):** Fuzzy Trace Theory — the brain maintains two parallel representations: verbatim traces (episodic) and gist traces (semantic). Verbatim traces decay rapidly; gist traces are more durable. Over time, you remember the meaning but not the exact words. This extends memory lifespan by allowing graceful degradation rather than total loss.

**Files:** `src/core/types.ts`, `src/core/store.ts` (backward compat normalizer), `src/core/consolidation.ts` (promotion step), hooks, MCP server, briefing

### 3. Temporal Associations

**What:** `recall` and `search_by_tag` now return temporal associations — memories formed in the same session as direct results, capped at 6.

**Why (neuroscience):** Temporal contiguity is the brain's strongest association mechanism. Recalling one memory activates others formed at the same time (same "episode"). The hippocampus links co-temporal events into episodes via theta-phase coupling. Synthetic sessions (mcp-store, consolidation) are excluded since they aren't real episodes.

**Files:** `src/core/store.ts` (getTemporalSiblings), `src/mcp/server.ts` (recall + search_by_tag output)

### 4. Learned Salience (VTA Dopamine Adaptation)

**What:** Reinforced, forgotten, and pruned memories emit salience signals. After 50+ signals, per-dimension weights (0.5–1.5) are computed and injected into the extraction prompt as calibration hints.

**Why (neuroscience):** The ventral tegmental area (VTA) dopamine system learns what to attend to through reward prediction errors. Reinforcement = positive reward signal; forgetting/pruning = negative. Over time, the system learns which salience dimensions (novelty, relevance, emotional, predictive) matter most for this specific user, adapting extraction to their actual needs.

**Files:** `src/core/salience-weights.ts`, `src/core/salience.ts` (weightsHint param), hooks, MCP server (reinforce/forget signal recording), consolidation (prune signal recording)

### 5. Context-Adaptive Briefing

**What:** Session briefing applies a 1.3x strength multiplier to project-scoped memories for sorting (doesn't change stored values). Sonnet prompt includes project name for context weighting.

**Why (neuroscience):** Context-dependent retrieval — the hippocampus uses environmental cues (place, activity) to modulate memory retrieval strength. Walking into your kitchen activates cooking memories; sitting at your desk activates work memories. Same principle: starting Claude Code in a project directory boosts that project's memories in the briefing.

**Files:** `src/core/briefing.ts` (BriefingContext, PROJECT_BOOST), `src/hooks/on-session-start.ts`

### Test Count: 60 → 91

---

## 2026-03-01: Token-Based Fuzzy Search

**What:** Search falls back to token matching when no exact substring match is found.

**Why (neuroscience):** Human memory retrieval is cue-based and associative — you don't need to remember the exact words to find a memory. Asking "Mike's kids" should surface memories about Miles and Macklin even though those exact words aren't stored together. Token matching with bidirectional substring comparison (query tokens match against content + tags) approximates the brain's fuzzy, cue-driven retrieval.

**Files:** `src/core/store.ts` (tokenize, tokenOverlap, two-phase search)

---

## 2026-03-01: Reconsolidation

**What:** The `reinforce` MCP tool accepts optional `new_content` to update a memory's text while strengthening it.

**Why (neuroscience):** Human memory is reconstructive, not reproductive. Every time you recall a memory, it becomes temporarily labile and can be modified — this is called reconsolidation. A memory about "Mike has one son" can be naturally updated to "Mike has two sons" when new information arrives, rather than requiring a delete-and-recreate cycle. The old content is always logged before overwriting as a safety net.

**Files:** `src/mcp/server.ts` (reinforce tool)

---

## 2026-03-01: Extraction Prompt Sharpening (Dedup)

**What:** Rewrote the Haiku extraction prompt to strongly emphasize dedup. Leads with "CRITICAL: Only extract information that is GENUINELY NEW" and instructs Haiku to skip routine confirmations, session metadata, and anything already covered by existing memories.

**Why:** The Stop hook fires after every Claude response, meaning Haiku sees overlapping context frequently. Without strong dedup instructions, it extracts memories that rephrase what's already stored, inflating the memory bank with redundancy. This is the prompt-level complement to consolidation's batch dedup.

**Files:** `src/core/salience.ts` (EXTRACTION_SYSTEM_PROMPT)

---

## 2026-02-28: Consolidation Engine (Phase 3)

**What:** Full Sonnet-powered sleep consolidation cycle. Merges redundant memories, extracts patterns from 3+ related memories, resolves contradictions, prunes superseded content. Auto-triggers on SessionStart when >50 memories and >3 days since last.

**Why (neuroscience):** During slow-wave sleep, the hippocampus replays important experiences to the cortex — essentially offline batch training on curated replay buffers. During REM sleep, the brain strips episodic details and extracts general patterns (distillation). Our consolidation mirrors both: it replays the full memory bank to Sonnet for merging (slow-wave analog) and extracts generalized patterns (REM analog). First live run: 127 → 65 memories, avg strength 0.59 → 0.71.

**Files:** `src/core/consolidation.ts`, `src/hooks/on-pre-compact.ts`

---

## 2026-02-28: PreCompact Hook

**What:** Fires before Claude Code compresses the context window. Extracts memories from content about to be lost, injects a mini-briefing so Claude retains key context post-compaction.

**Why (neuroscience):** Analogous to the hippocampus rapidly encoding important information before it's lost from working memory. When the context window is about to shrink (like the brain's attention shifting), the most important active content needs to be consolidated first.

**Files:** `src/hooks/on-pre-compact.ts`, `hooks/pre-compact.sh`

---

## 2026-02-28: MCP Server (Phase 2)

**What:** 7 tools exposed to Claude mid-conversation: status, recall, search_by_tag, reinforce, store, forget, consolidate.

**Why (neuroscience):** The brain has both passive memory formation (hippocampal encoding during experience) and active retrieval (deliberate recall, directed search). The hooks handle passive formation. The MCP tools give Claude active memory access — the ability to deliberately search, strengthen, correct, or remove memories. This maps to the prefrontal cortex's role in directing memory retrieval and the executive control of memory processes.

**Files:** `src/mcp/server.ts`

---

## 2026-02-28: Core Memory Engine (Phase 1)

**What:** Types, strength calculation, JSON store with file locking, transcript parser, Haiku-powered extraction, Sonnet-powered briefing, 4 lifecycle hooks.

**Why (neuroscience):** The full system maps to hippocampal memory formation:
- **Salience scoring** (4 dimensions: novelty, relevance, emotional, predictive) → amygdala + dopaminergic gating
- **Strength formula** (salience + retrieval boost + consolidation bonus - decay) → synaptic strength with Hebbian learning and forgetting curves
- **Forgetting curves** → synaptic decay / regularization preventing overfitting to one-time events
- **Context briefings** → memory reconstitution from compressed indices (how the hippocampus reconstructs memories by reactivating cortical patterns)

**Files:** `src/core/*`, `src/hooks/*`, `hooks/*`
