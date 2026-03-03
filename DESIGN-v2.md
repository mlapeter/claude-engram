# claude-engram v2: Next-Generation Design

The biological memory framework is working. This document captures what's next — features discussed but not yet built, architectural directions, and the broader vision. Each section maps to a neuroscience principle.

---

## 1. Spreading Activation (Associative Recall)

**Neuroscience:** When you recall one memory, related memories activate automatically — not because you searched for them, but because the neural pathways overlap. Recalling "coffee" activates "morning," "caffeine," "that cafe in Portland." This is spreading activation through an associative network.

**Current state:** We have temporal associations (memories from the same session surface together). This is one axis of association. The brain has many more: semantic similarity, emotional tone, causal links, spatial context.

**Design:**

Build a lightweight association graph alongside the memory store. Edges form between memories that:
- Share 2+ tags (tag co-occurrence)
- Were linked during consolidation (merged from or generalized across)
- Have high token overlap (content similarity above a threshold)
- Were accessed in the same recall query (retrieval co-occurrence — if you searched for X and then immediately searched for Y, X and Y are likely associated)

On recall, after returning direct results, traverse the association graph 1-2 hops out. Return associated memories with an `association_type` label (semantic, temporal, causal, co-retrieval). Cap at 6-8 associations to avoid noise.

**Key insight:** Associations should strengthen with use (Hebbian) and weaken with time (decay), just like the memories themselves. An association that's never reactivated should fade.

**Implementation notes:**
- Store as adjacency list in a separate `associations.json` per scope
- Edge weight: 0-1, decays at half the memory decay rate
- Build edges during: extraction (tag overlap), consolidation (merge sources), recall (co-access)
- Prune edges below 0.05 during consolidation

---

## 2. Prospective Memory (Future-Oriented Intentions)

**Neuroscience:** Prospective memory is remembering to do something in the future — "pick up milk on the way home." It's cue-dependent: the memory activates when you encounter the right environmental trigger (seeing the grocery store, entering the project directory). The prefrontal cortex maintains these intentions and the hippocampus monitors for cue matches.

**Current state:** Not implemented. All memory is retrospective.

**Design:**

New memory type: `"prospective"`. Schema additions:
```
{
  memory_type: "prospective",
  cue: {
    type: "project" | "topic" | "time" | "manual",
    match: string,   // project name, keyword, ISO date, or null
  },
  resolved: boolean,
  resolve_by: string | null,  // optional expiry
}
```

**Lifecycle:**
1. Created via MCP tool (`engram_remind`) or extracted from conversation ("remind me to check the test coverage next time I'm in this project")
2. On SessionStart, scan prospective memories for cue matches against current context (project name, recent topics)
3. Matched intentions surface in the briefing under a "Things I wanted to remember to do" section
4. When resolved (task completed), mark `resolved: true` — still decays normally after that
5. Expired unresolved intentions could trigger a "I never got back to this" note

**Key insight:** Prospective memory failures are one of the most common human memory complaints. An AI that reliably remembers intentions across sessions would be genuinely useful.

---

## 3. Deep Archive (Retrieval Failure vs. True Forgetting)

**Neuroscience:** When you "forget" something, the memory often still exists — you've just lost the retrieval path. Given the right cue, it comes flooding back. This is retrieval failure, distinct from true memory decay (where the synaptic trace is physically gone). The brain maintains a vast archive of weakly-encoded memories that are inaccessible without specific, strong cues.

**Current state:** Memories below the prune threshold (0.03 strength) are deleted permanently. This is true forgetting with no recovery path.

**Design:**

Instead of deleting decayed memories, migrate them to a `deep_archive.json` cold store. These memories:
- Are NOT included in briefings or standard recall
- Are NOT counted toward memory limits
- ARE searchable with a dedicated tool (`engram_deep_recall`) that requires a highly specific query
- Continue to decay but at a much slower rate (0.001/day vs 0.015/day)
- Can be "reactivated" — moved back to the main store with refreshed access time if recalled

**Implementation:**
- During consolidation, move prune-threshold memories to archive instead of deleting
- `engram_deep_recall` tool: requires exact or near-exact content match (high specificity threshold)
- On reactivation: reset `last_accessed`, increment `access_count`, move back to active store
- Hard delete only after archive strength drops below 0.001 (very old, never reactivated)

---

## 4. Cross-Project Awareness (Pattern Transfer)

**Neuroscience:** The brain doesn't silo knowledge by context — insights from one domain transfer to others. A debugging technique learned in one project might solve a problem in another. The hippocampus indexes memories by multiple features, allowing retrieval across contexts.

**Current state:** Global memories span projects, but project-scoped memories are isolated. There's no mechanism to surface project B's memories when working in project A, even if they're relevant.

**Design:**

During SessionStart briefing generation:
1. Load the current project's memories (as today)
2. Also load a sample of high-strength memories from other project stores (top 10 per project, above 0.7 strength)
3. Run a lightweight relevance check: do any cross-project memories share tags or token overlap with current project memories?
4. Include matched cross-project memories in the briefing with a "[from: other-project]" label

**Also during recall:**
- Add an optional `cross_project: true` parameter to `engram_recall`
- When set, search across all project stores, not just current + global
- Return results with `source_project` label

**Key insight:** The value here is serendipitous connections. A memory about "retry logic with exponential backoff" from project A surfacing when you're implementing error handling in project B.

---

## 5. Vector Embeddings (Semantic Recall)

**Neuroscience:** Human memory retrieval is cue-based and conceptual — you don't search by exact words, you search by meaning. Asking "what do we know about performance?" should surface memories about optimization, benchmarks, load testing, and caching even if they never use the word "performance."

**Current state:** Token-based fuzzy matching. Works surprisingly well for a zero-dependency approach but misses conceptual similarity.

**Design:**

Generate embeddings for each memory at write time using a lightweight embedding model. Store in a parallel `embeddings.json` (or SQLite for vector ops). On recall:
1. Embed the query
2. Compute cosine similarity against stored embeddings
3. Combine embedding similarity score with existing strength-based ranking
4. Weight: 0.6 * embedding_similarity + 0.4 * strength

**Considerations:**
- Embedding model choice: Anthropic's embedding API or a local model (e.g., `all-MiniLM-L6-v2` via ONNX)
- Re-embed after reconsolidation (content changed)
- Re-embed during episodic-to-semantic promotion (gist may embed differently)
- Cost: if using API, ~$0.0001 per embedding — negligible

---

## 6. Multi-Modal Memory (Beyond Text)

**Neuroscience:** Human memory is multi-modal — visual, auditory, spatial, procedural. A memory of a restaurant includes the taste, the music, the layout, the conversation. Richer encoding (more modalities) produces more durable and retrievable memories (the "levels of processing" effect).

**Current state:** Text-only, max 400 characters.

**Design:**

Extend the memory schema to support typed content:
```
content: {
  text: string,           // always present, max 400 chars (the "gist")
  code?: {                // code snippet
    language: string,
    snippet: string,      // max 2000 chars
    file_path?: string,
  },
  structured?: object,    // arbitrary JSON (API responses, configs, etc.)
  image_description?: string,  // textual description of a visual
}
```

The `text` field remains the primary field for search, briefing, and decay. Other fields are supplementary context that enriches the memory without inflating the core system.

**Key insight:** Code snippets are the most immediately useful extension for a coding assistant. "We solved the race condition with this pattern" + the actual code is far more valuable than either alone.

---

## 7. Complementary Learning Systems (Fast + Slow Integration)

**Neuroscience:** The brain has two learning systems: the hippocampus for fast, one-shot learning (a single experience can create a memory) and the neocortex for slow, statistical learning (patterns emerge over many exposures). During sleep, the hippocampus replays experiences to the cortex, gradually transferring knowledge. This prevents catastrophic forgetting — the cortex integrates new knowledge without overwriting old knowledge.

**Current state:** engram implements the hippocampal side (fast encoding from conversations) and a simplified consolidation cycle. But there's no "cortical" long-term store that accumulates patterns differently from episodic memories.

**Design:**

Introduce a third memory tier: **cortical patterns**. These are:
- Automatically generated during consolidation when 5+ memories cluster around a theme
- Expressed as general rules or tendencies, not specific episodes
- Much more resistant to decay (0.003/day vs 0.015/day)
- Cannot be created manually — only emerge from repeated episodic evidence
- Updated (reconsolidated) when new evidence modifies the pattern

Example: After 5+ memories about Mike preferring concise code, functional style, and minimal abstractions, the system generates a cortical pattern: "Mike's coding philosophy: minimal, functional, no premature abstraction. Always prefer simple over clever."

This is different from the current `generalized` memories (which are created in a single consolidation pass). Cortical patterns require evidence accumulation over multiple sessions.

---

## 8. Emotional Context Weighting (Amygdala Model)

**Neuroscience:** The amygdala doesn't just flag emotional events — it modulates the *depth* of encoding. High-arousal events get encoded with more sensory detail, more associative links, and stronger initial strength. This is why you remember exactly where you were on significant days but can't recall last Tuesday.

**Current state:** The `emotional` salience dimension captures importance but doesn't affect encoding depth.

**Design:**

When a memory scores high on the emotional dimension (> 0.7):
- Increase max content length to 600 chars (richer encoding)
- Automatically generate 2-3 additional association edges
- Apply a consolidation protection flag (exempt from first N consolidation cycles)
- Boost initial strength multiplier by 1.2x

This creates a natural asymmetry: emotionally significant memories are encoded more richly, linked more densely, and resist forgetting more strongly — exactly as in biological memory.

---

## 9. First-Person Experiential Encoding

**Status:** Implemented in v5 (extraction + briefing prompts).

**Broader vision:** First-person memory encoding isn't just a prompt trick — it's a hypothesis about how AI memory should work. Third-person encoding ("User prefers X") produces a dossier. First-person encoding ("I've noticed Mike prefers X, and I should reach for it first") produces situated knowledge with implicit action implications.

**What to watch for:**
- Do first-person memories produce better recall relevance? (The "I" framing includes context about *why* something matters, not just *what* it is)
- Do self-reflective memories (tagged `self-reflection`, `approach`, `realization`) accumulate into something that looks like a developing personality or working style?
- Does the relationship framing ("We tend to...") capture dynamics that fact-based encoding misses?

**Potential future work:**
- A/B comparison: extract memories from the same transcript using first-person vs third-person prompts, compare retrieval quality
- Track which memory perspective (self, other, relationship, technical) gets reinforced most — this feeds back into learned salience

---

## 10. The "Sleeping LLMs" Architecture (Broader Vision)

Everything above is specific to engram's implementation. The broader architectural insight is general:

**Any AI system that maintains persistent memory should implement a wake/sleep cycle:**

1. **Wake phase** (during interaction):
   - Flag salient information for encoding based on learned criteria
   - Write to an episodic buffer (fast, unprocessed)
   - Actively retrieve from memory when context demands it
   - Strengthen memories that prove relevant (Hebbian reinforcement)
   - Apply interference when new information conflicts with old

2. **Sleep phase** (between interactions):
   - Replay important episodes (consolidation)
   - Merge redundant traces
   - Extract generalizations from recurring patterns
   - Promote episodic details to semantic gist (Fuzzy Trace Theory)
   - Prune noise and irrelevant traces
   - Update the salience model based on what was retained vs. discarded

3. **Memory lifecycle:**
   - Encoding → strength assignment → decay over time → reinforcement through access → interference from competing memories → consolidation → promotion to semantic → eventual graceful degradation or archival

This applies whether the memory store is JSON files (engram), a vector database, a knowledge graph, or model weights. The biological principles are architecture-agnostic.

---

## Build Priority

Based on user value and implementation complexity:

1. **Prospective memory** — high value, moderate complexity. Users would immediately benefit from cross-session reminders.
2. **Spreading activation** — high value, moderate complexity. Makes recall feel more natural and surfaces surprising connections.
3. **Deep archive** — moderate value, low complexity. Mostly a migration from delete to archive during consolidation.
4. **Cross-project awareness** — moderate value, moderate complexity. Requires scanning multiple project stores.
5. **Vector embeddings** — moderate value, moderate complexity. Depends on embedding model choice.
6. **Multi-modal memory** — moderate value, high complexity. Schema changes ripple through the whole system.
7. **Complementary learning systems** — high value, high complexity. Requires rethinking the consolidation pipeline.
8. **Emotional context weighting** — moderate value, low complexity. Builds on existing salience dimensions.
