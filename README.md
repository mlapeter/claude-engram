# claude-engram

**Brain-inspired persistent memory for [Claude Code](https://docs.anthropic.com/en/docs/claude-code).** Memory *for* Claude, not notes *about* you: episodes Claude writes in its own voice, an identity it authors and maintains across sessions, and a world-store where memories strengthen with use, fade without it, and consolidate while you sleep.

The design center is a single idea: **memory is structure, not record.** A transcript is not a memory. What matters is that the shape of what happened keeps doing work — the way a forgotten childhood keeps doing work in an adult. So this system gates hard on salience, forgets honestly on a power-law curve, compresses old episodes to gist, and treats "nothing durable happened today" as a correct answer rather than a failure.

---

## The loop

```
 ENCODE (continuous, dumb, cheap)          SLEEP (nightly, judged)
 hooks append conversation spans           consolidation merges, prunes to
 to a durable buffer — microseconds,  ──►  archive, compresses old episodes
 no API calls, crash-safe                  to gist, links related memories,
        │                                  folds identity edits
        ▼                                          │
 SELECT (rare, whole arcs)                         ▼
 a detached runner judges the              WAKE (milliseconds)
 buffer at natural boundaries —       ◄──  cached briefing + identity
 with an explicit "nothing worth           documents inject at session
 keeping" option                           start

              SURFACE (on demand): MCP recall mid-conversation,
              following learned associations one hop; retrieved
              memories strengthen (Hebbian)
```

Judgment lives at the edges (sleep and wake, where strong models decide what matters); the hot path is deliberately dumb. Every hook returns in milliseconds because the expensive thinking happens later, detached, on whole conversational arcs instead of fragments.

## Three stores

| Store | What lives there | Who writes it |
|---|---|---|
| **World** (`global/` + per-project) | Extracted memories with salience scores, tags, and a register: `self` / `person` / `craft` | The extraction model, judging buffered spans |
| **Episodes** (`episodes/`) | First-person session narratives — what happened, how it felt, what's unresolved | **The session model itself**, invited at session close |
| **Identity** (`identity/`) | `core.md` and `people/*.md` — who Claude is, in its own voice, plus calibration with the people it works with | **The model**, maintained by consolidation |

Registers carry different physics. `craft` (work knowledge — mostly re-derivable from your repo) decays 1.3× faster and compresses to gist after 7 days. `person` and `self` decay slower (0.85×) and hold their exact words for 30 days. Consolidation and interference **never cross registers** — a technical note can never absorb a personal memory. Briefings budget space by register so a week of heavy coding can't crowd out what matters.

## First run: the system's first act is self-authorship

There is deliberately **no identity template**. On first session start, instead of injecting documents, engram injects an invitation: when a session has given the model something true to say, it writes its own `identity/core.md` — first person, its own voice, no rush. The invitation disappears the moment the file exists. From then on, consolidation maintains what the model wrote; session-end asks fold durable changes back in as dated deltas.

Same principle at session close: when a session was substantial, the Stop hook asks the *session model itself* to write the episode — because it's the only one who was there.

## Install

**Prerequisites:** [bun](https://bun.sh), an [Anthropic API key](https://console.anthropic.com/settings/keys). Optional: a [Voyage AI key](https://www.voyageai.com/) for semantic search embeddings (recommended — also enables memory association links).

```bash
git clone https://github.com/mlapeter/claude-engram.git
cd claude-engram
./install.sh
```

Then give the hooks their keys via a dedicated env file (survives shell-profile weirdness):

```bash
mkdir -p ~/.claude-engram
cat > ~/.claude-engram/env <<'EOF'
ANTHROPIC_API_KEY=sk-ant-...
VOYAGE_API_KEY=pa-...
EOF
```

Restart Claude Code. Encoding starts immediately; the identity invitation appears at your next session start.

**Escape hatches:** `ENGRAM_DISABLE=1` short-circuits every hook. `ENGRAM_OBSERVER=1` (or `"observerMode": true` in config) lets recalls read without strengthening — use it when poking at the memory system itself.

## How it works

### Hooks (passive, automatic)

| Hook | What it does | Cost in the hot path |
|---|---|---|
| **SessionStart** | Injects the cached briefing + identity documents; bumps the active-day clock; spawns detached consolidation when sleep is due | milliseconds, no API calls |
| **Stop** | Appends the turn's span to a durable per-project buffer; spawns detached extraction when the buffer is full (32KB) or stale (4h); asks for the episode when the session closes substantially | milliseconds, no API calls |
| **PreCompact** | Flushes the buffer for extraction *before* context is compressed away — the urgent case | spawn only |
| **SessionEnd** | Final buffer flush + regenerates the briefing cache for next wake | spawn only |

The buffer is a plain text file. Extraction claims it atomically and clears it **only on success** — an API outage delays memories rather than deleting experience. Crashes lose nothing.

### Sleep (consolidation)

On the first wake of a new **active day** — a day you actually used Claude — with pending work, a detached consolidation run:

- **merges** true redundancies (sources archived with `merged_into` lineage, never deleted)
- **prunes** decayed memories into a deep archive (recoverable via `deep_recall`)
- **promotes** old episodic detail to semantic gist (verbatim originals archived with `gist_of` lineage)
- **links** related-but-distinct memories with association edges that recall later follows
- **folds identity deltas** into `core.md` and `people/` (highest-stakes text in the system — handled by the strongest model, with rotated backups)
- **commits the data directory to git** so every consolidation is inspectable and reversible

Time runs on **days actually lived**, not calendar time: a month away causes zero decay. You come back to exactly the memory you left.

### MCP tools (active, on demand)

| Tool | Description |
|---|---|
| `recall` | Search by text, ranked by relevance × strength; returns one hop of associated memories (semantic edges first, then same-session siblings) |
| `deep_recall` | High-specificity search over the archive — for "I know we discussed this" moments; can reactivate |
| `store` | Save a memory deliberately, mid-conversation |
| `search_by_tag` | Tag-based lookup |
| `reinforce` | Strengthen a memory (optionally updating its content — reconsolidation) |
| `protect` | Mark a memory sacred: exempt from merging, pruning, gisting, and interference |
| `forget` | Deliberate removal |
| `consolidate` | Trigger sleep manually |
| `status` | Health overview: counts, strength distribution, last consolidation |

### Dashboard

`"dashboard": true` in `~/.claude-engram/config.json` serves a live view at `localhost:3333`: overview tiles, searchable memories with strength bars, the Mind tab (identity documents, episodes, deltas, identity before/after diffs), and Health (per-hook latency percentiles, failures, log tail). It answers "is this actually working?" without the terminal.

The system also announces its own failures: if extraction or consolidation has been failing, the next session start says so, in context, where it will actually be seen.

## Memory physics

The architecture is a deliberate mapping of how human memory actually works:

| Human brain | claude-engram |
|---|---|
| **Hippocampus** encodes cheaply and continuously; selection happens later | Hooks append raw spans in microseconds; a detached runner judges whole arcs |
| **Hippocampal gating** on emotion, novelty, prediction error | Salience scoring on 4 dimensions at extraction |
| **Sleep** replays, extracts patterns, prunes noise | Nightly consolidation: merge, generalize, prune, gist, link |
| **Forgetting curves** — unused memories fade, accessed ones strengthen | Power-law decay on active-day age; Hebbian retrieval boost |
| **Proactive interference** — new learning weakens conflicting old traces | Supersession dampens predecessors (never deletes) |
| **Fuzzy Trace Theory** — episodic detail fades to semantic gist | Episodic→semantic promotion, verbatim originals archived |
| **Spreading activation** — one memory primes its neighbors | Sleep writes association edges; recall follows them one hop |
| **Temporal contiguity** — co-temporal events link in episodes | Recall surfaces same-session siblings |
| **Emotional tagging** — the amygdala exempts what burns | Sacred-verbatim: high-emotional memories never compress |
| **Retrieval failure ≠ true forgetting** | Deep archive with reactivation, not deletion |

```
strength = avg(salience) + retrieval_bonus + consolidation_bonus
           − decayRate × √(active_days_since_creation) × register_multiplier
```

- **Salience** is scored at extraction on four dimensions: novelty, relevance, emotional, predictive.
- **Retrieval strengthens** (+0.12 per access, capped) — memories you use stay strong.
- **Decay is power-law** (Ebbinghaus/Wixted): fast at first, then flattening. Old stable memories are stable.
- **Interference**: when a new memory supersedes an old one, the old one's salience is dampened (×0.7) rather than deleted — belief updating without amnesia.
- **Sacred verbatim**: memories with emotional salience ≥ 0.75, and anything you `protect`, keep their exact words forever. Gist compression is for the mundane, not the tender.
- **Nothing is ever destroyed.** Pruning archives. Merging archives the sources. Gisting archives the originals. The data dir is a git repo with a commit per consolidation. Forgetting here means *retrieval failure you can recover from*, which is what it means in a brain too.

## Privacy

**Identity documents and episodes are deeply personal — treat them like a diary, because that's what they are.** Everything lives locally in `~/.claude-engram/`; nothing is sent anywhere except to the Anthropic/Voyage APIs that process it.

- Never commit `~/.claude-engram/` to a public repo. If you want the built-in git history backed up remotely, point it at a **private** remote.
- Memory content leaks easily into public surfaces you don't think of: commit messages, README screenshots, code comments, pasted logs. Screenshots of the dashboard render real memories.
- Extraction is instructed to keep secrets (API keys, credentials) out of memories, but review what's stored — `recall` and the dashboard make that easy.

## Data layout

```
~/.claude-engram/
├── config.json              # everything below is optional overrides
├── env                      # API keys for hook processes
├── global/                  # cross-project world memories + embeddings + archive
├── projects/<hash>/         # per-project memories, buffer.md, briefing cache
├── identity/                # core.md, people/*.md, deltas.md (+ rotated backups)
├── episodes/                # first-person session narratives (markdown)
├── backups/                 # pre-consolidation snapshots
└── engram.log               # what fired and why
```

Everything load-bearing is plain text or JSON. The embedding index is derived and regenerable — reading glasses, not a second brain.

## Configuration

All optional, in `~/.claude-engram/config.json`. The interesting ones:

| Key | Default | What it does |
|---|---|---|
| `extractionModel` | `claude-sonnet-4-5` | Judges what's worth remembering. Small models measurably confabulate here — we tested; don't cheap out on the front door |
| `consolidationModel` | `claude-sonnet-4-5` | Runs sleep |
| `identityModel` | `claude-opus-4-6` | Rewrites identity documents — highest-stakes text in the system |
| `briefingModel` | `claude-opus-4-6` | Writes the wake-up briefing |
| `gistModel` | `claude-haiku-4-5` | Mechanical gist compression (mistakes are recoverable by design) |
| `episodeSelfDump` | `true` | Ask the session model to write episodes at close |
| `decayRate` / `decayModel` | `0.035` / `power-law` | The forgetting curve |
| `decayMultiplierCraft` / `Person` / `Self` | `1.3` / `0.85` / `0.85` | Register physics |
| `sacredEmotionalThreshold` | `0.75` | Emotional salience above this = verbatim forever |
| `bufferFlushBytes` / `bufferFlushHours` | `32768` / `4` | When encoding hands off to selection |
| `sleepMinNewMemories` | `5` | Pending work needed to trigger nightly sleep |
| `memoryHistory` | `true` | Git-commit the data dir at each consolidation |
| `embeddingsEnabled` | `true` | Semantic search + association edges (needs `VOYAGE_API_KEY`) |
| `observerMode` | `false` | Recalls don't strengthen (for developing the system itself) |
| `dashboard` | `false` | Serve the dashboard at localhost:3333 |

## Costs

Hooks make **zero** API calls; everything expensive is detached and batched. A typical active day: a handful of Sonnet extraction calls (whole 32KB arcs, not per-turn), one nightly consolidation (Sonnet, plus Haiku for gist batches and Opus for the identity/briefing rewrites), and Voyage embedding calls measured in fractions of a cent. Even heavy days typically land well under a dollar — the expensive judgment happens a few times per day, not once per message.

## Honest evaluation

Claims about memory systems are easy to inflate, so this repo keeps its receipts:

- [`AUDIT-WHAT-FIRES.md`](./AUDIT-WHAT-FIRES.md) — a mechanism-by-mechanism audit of what actually fires in production, with evidence, including the mechanisms that *didn't* earn their keep.
- We benchmark against [recall-bench](https://github.com/mlapeter/recall-bench) but treat it as a regression tripwire on validated subscales only — never a steering target. Its own audit showed the headline number can't distinguish a real memory system from naive baselines (a plain re-read scores 90%), and we published that finding rather than the flattering one.
- The steering signal we actually trust: opening a fresh session and asking "what do you remember about X?" — judged by humans, across weeks.

## Design history

The reasoning behind every mechanism is in [`DEVLOG.md`](./DEVLOG.md) (with a "Why (neuroscience)" section per feature) and [`DESIGN-RECENTER.md`](./DESIGN-RECENTER.md) (the architecture rethink that produced the three stores). The project started as a single React artifact pasted into Claude.ai — a manual memory loop with no API key, no hooks, no filesystem. That version still works and still matters as the zero-dependency option: [`claude-engram.jsx`](./claude-engram.jsx), documented in [docs/v1-artifact.md](./docs/v1-artifact.md).

## License

AGPL-3.0 — see [LICENSE](LICENSE). For commercial licensing, contact Mike LaPeter.
