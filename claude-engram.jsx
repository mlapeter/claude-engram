import { useState, useEffect, useCallback } from "react";

const STORAGE = {
  memories: "nmb-mem-v3",
  meta: "nmb-meta-v3",
  briefing: "nmb-brief-v3",
};

const DECAY_RATE = 0.015;
const RETRIEVAL_BOOST = 0.12;
const AUTO_CONSOL_DAYS = 3;

const SAL_DIMS = [
  { key: "novelty", label: "Novelty", color: "#b07ce8" },
  { key: "relevance", label: "Relevance", color: "#d97706" },
  { key: "emotional", label: "Emotional", color: "#e06c8a" },
  { key: "predictive", label: "Predictive", color: "#3b9ecf" },
];

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const daysAgo = ts => Math.max(0, (Date.now() - ts) / 864e5);

function strength(m) {
  const age = daysAgo(m.createdAt);
  const n = Number(m.salience?.novelty) || 0;
  const r = Number(m.salience?.relevance) || 0;
  const e = Number(m.salience?.emotional) || 0;
  const p = Number(m.salience?.predictive) || 0;
  const sal = (n + r + e + p) / 4;
  return Math.max(0, Math.min(1, sal + Math.min(m.accessCount * RETRIEVAL_BOOST, 0.5) + (m.consolidated ? 0.2 : 0) - DECAY_RATE * age));
}

function sCol(s) { return s > 0.7 ? colors.green : s > 0.4 ? colors.accent : s > 0.2 ? "#ea6d2f" : colors.red; }
function sLbl(s) { return s > 0.7 ? "Strong" : s > 0.4 ? "Stable" : s > 0.2 ? "Fading" : "Decaying"; }

async function load(key) { try { const r = await window.storage.get(key); return r ? JSON.parse(r.value) : null; } catch { return null; } }
async function save(key, data) { try { await window.storage.set(key, JSON.stringify(data)); return true; } catch { return false; } }

async function askClaude(system, user, tokens = 4000) {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: tokens, system, messages: [{ role: "user", content: user }] }),
    });
    const d = await r.json();
    return d.content?.map(b => b.type === "text" ? b.text : "").join("") || null;
  } catch (e) { console.error("API:", e); return null; }
}

function repairJSON(raw) {
  let s = raw.replace(/```json|```/g, "").trim();
  try { return JSON.parse(s); } catch {}
  const lastComplete = Math.max(s.lastIndexOf("},"), s.lastIndexOf("}]"));
  if (lastComplete > 0) {
    let attempt = s.slice(0, s.lastIndexOf("},") + 1);
    if (!attempt.endsWith("]")) attempt += "]";
    try { return JSON.parse(attempt); } catch {}
    attempt = s.slice(0, s.lastIndexOf("}") + 1);
    if (!attempt.endsWith("]")) attempt += "]";
    try { return JSON.parse(attempt); } catch {}
  }
  return null;
}

const INGEST_SYS = `You are a hippocampal memory processor. Extract discrete, atomic memories from the input. For each, evaluate salience (0.0-1.0) on: novelty (surprising/new), relevance (useful for future), emotional (personal significance), predictive (changes expectations). Assign 1-4 tags from: identity, goal, preference, project, relationship, skill, insight, contradiction, pattern, context, technical, personal, business, creative.

You will also receive EXISTING MEMORIES. If new info contradicts or updates an existing memory, set the "updates" field to that memory's ID.

Respond ONLY with a JSON array, no markdown fences:
[{"content":"<max 300 chars>","salience":{"novelty":0.0,"relevance":0.0,"emotional":0.0,"predictive":0.0},"tags":["tag"],"updates":null}]`;

const TRANSCRIPT_SYS = `You are a hippocampal memory processor analyzing a full conversation transcript. Extract every piece of information worth remembering as discrete, atomic memories. Be thorough — capture facts, decisions, preferences, emotional moments, plans, insights, and context.

Score each on salience (0.0-1.0): novelty, relevance, emotional, predictive. Assign 1-4 tags from: identity, goal, preference, project, relationship, skill, insight, contradiction, pattern, context, technical, personal, business, creative.

You also receive EXISTING MEMORIES. Flag updates/contradictions via the "updates" field with the existing memory ID.

Respond ONLY with a JSON array, no markdown fences:
[{"content":"<max 300 chars>","salience":{"novelty":0.0,"relevance":0.0,"emotional":0.0,"predictive":0.0},"tags":["tag"],"updates":null}]`;

const CONSOL_SYS = `You are a sleep consolidation processor analyzing memories for optimization. Tasks:
1. Merge redundant memories (combine into one stronger memory)
2. Resolve contradictions (keep newest, update content)
3. Extract patterns (create generalized memories from recurring themes)
4. Flag trivial/superseded memories for pruning

Respond ONLY with JSON, no fences:
{"merge":[{"ids":["id1","id2"],"merged":{"content":"...","salience":{...},"tags":[...]}}],"generalize":[{"content":"...","salience":{...},"tags":[]}],"prune_ids":["id3"],"notes":"brief description of what changed"}`;

const EXPORT_SYS = `Generate a concise context briefing from these memories for use as persistent context in a new AI conversation. Structure:

## Active Context
(Current goals, projects, immediate concerns — strongest/most relevant memories)

## Core Knowledge
(Established facts — consolidated memories about identity, preferences, relationships)

## Recent Patterns
(Behavioral patterns, recurring themes, emerging interests)

## Fading Context
(Potentially relevant but losing salience — brief mentions only)

Keep total output under 2000 chars. Dense, informative, system-prompt style. Not conversational.`;

// ═══ Components ═══

const colors = {
  bg: "#292521",
  surface: "#33302b",
  surfaceHover: "#3b3733",
  border: "#4a453f",
  borderLight: "#5c564f",
  text: "#ece5de",
  textSecondary: "#c4bbb2",
  textTertiary: "#9b9389",
  accent: "#e07a2f",
  accentMuted: "rgba(224,122,47,0.14)",
  green: "#2da44e",
  greenMuted: "rgba(45,164,78,0.14)",
  red: "#d4493f",
  redMuted: "rgba(212,73,63,0.12)",
  purple: "#a371f7",
  purpleMuted: "rgba(163,113,247,0.12)",
  blue: "#4a9ced",
  blueMuted: "rgba(74,156,237,0.12)",
};

function Badge({ children, color, bg }) {
  return (
    <span style={{
      fontSize: 11, fontWeight: 500, color, background: bg,
      padding: "2px 8px", borderRadius: 10, whiteSpace: "nowrap",
    }}>{children}</span>
  );
}

function MemCard({ m, open, onToggle, onReinforce, onDelete }) {
  const s = strength(m);
  const c = sCol(s);
  return (
    <div onClick={onToggle} style={{
      background: colors.surface, border: `1px solid ${colors.border}`,
      borderRadius: 12, padding: "14px 16px", marginBottom: 8, cursor: "pointer",
      transition: "background 0.15s",
    }}
    onMouseEnter={e => e.currentTarget.style.background = colors.surfaceHover}
    onMouseLeave={e => e.currentTarget.style.background = colors.surface}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <Badge color={c} bg={`${c}18`}>{sLbl(s)} · {(s * 100) | 0}%</Badge>
        {m.consolidated && <Badge color={colors.green} bg={colors.greenMuted}>Consolidated</Badge>}
        {m.generalized && <Badge color={colors.purple} bg={colors.purpleMuted}>Pattern</Badge>}
        <span style={{ marginLeft: "auto", fontSize: 12, color: colors.textSecondary }}>{daysAgo(m.createdAt).toFixed(0)}d ago</span>
      </div>
      <p style={{ color: colors.text, fontSize: 14, margin: 0, lineHeight: 1.55 }}>{m.content}</p>

      {open && (
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${colors.border}` }}>
          {/* Salience bars */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 16px", marginBottom: 14 }}>
            {SAL_DIMS.map(d => (
              <div key={d.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 12, color: colors.textSecondary, width: 68 }}>{d.label}</span>
                <div style={{ flex: 1, height: 6, background: colors.bg, borderRadius: 3, overflow: "hidden" }}>
                  <div style={{ width: `${m.salience[d.key] * 100}%`, height: "100%", background: d.color, borderRadius: 3, transition: "width 0.3s" }} />
                </div>
                <span style={{ fontSize: 11, color: colors.textTertiary, width: 28, textAlign: "right" }}>{(m.salience[d.key] * 100) | 0}</span>
              </div>
            ))}
          </div>

          {m.tags?.length > 0 && (
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 12 }}>
              {m.tags.map(t => (
                <span key={t} style={{
                  fontSize: 11, background: colors.bg, color: colors.textSecondary,
                  padding: "3px 8px", borderRadius: 6, border: `1px solid ${colors.border}`,
                }}>{t}</span>
              ))}
            </div>
          )}

          <div style={{ fontSize: 12, color: colors.textTertiary, marginBottom: 12 }}>
            Accessed {m.accessCount}× · Created {new Date(m.createdAt).toLocaleDateString()}
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={e => { e.stopPropagation(); onReinforce(); }} style={actionBtn(colors.green, colors.greenMuted)}>↑ Reinforce</button>
            <button onClick={e => { e.stopPropagation(); onDelete(); }} style={actionBtn(colors.red, colors.redMuted)}>✕ Prune</button>
          </div>
        </div>
      )}
    </div>
  );
}

function actionBtn(color, bg) {
  return {
    background: bg, border: `1px solid ${color}30`, color,
    fontSize: 12, fontWeight: 500, padding: "6px 14px", borderRadius: 8, cursor: "pointer",
  };
}

function LogPanel({ lines }) {
  if (!lines.length) return null;
  return (
    <div style={{ marginTop: 14, padding: 14, background: colors.bg, borderRadius: 10, border: `1px solid ${colors.border}` }}>
      {lines.map((l, i) => (
        <div key={i} style={{
          fontSize: 13, lineHeight: 1.7,
          color: l.startsWith("✓") ? colors.green : l.startsWith("✕") ? colors.red : l.startsWith("⚠") ? colors.accent : l.startsWith("◉") ? colors.purple : colors.textSecondary,
        }}>{l}</div>
      ))}
    </div>
  );
}

// ═══ Main ═══
export default function ClaudeEngram() {
  const [mems, setMems] = useState([]);
  const [meta, setMeta] = useState({ lastConsol: null, created: null });
  const [briefing, setBriefing] = useState("");
  const [loading, setLoading] = useState(true);
  const [bootLog, setBootLog] = useState([]);
  const [view, setView] = useState("briefing");
  const [expId, setExpId] = useState(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("strength");

  const [rawIn, setRawIn] = useState("");
  const [mode, setMode] = useState("summary");
  const [processing, setProcessing] = useState(false);
  const [ingestLog, setIngestLog] = useState([]);

  const [consoling, setConsoling] = useState(false);
  const [consolLog, setConsolLog] = useState([]);
  const [exporting, setExporting] = useState(false);

  // Toast & confirm dialog (alert/confirm don't work in iframes)
  const [toast, setToast] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState(null);
  const showToast = (msg, isError) => { setToast({ msg, isError }); setTimeout(() => setToast(null), 4000); };
  const showConfirm = (msg, onYes) => setConfirmDialog({ msg, onYes });

  // Copy helper that works in iframes
  const copyText = (text) => {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "-9999px";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try { document.execCommand("copy"); } catch {}
    document.body.removeChild(textarea);
  };
  const [copied, setCopied] = useState(false);
  const handleCopy = (text) => {
    copyText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const persist = useCallback(async (m) => { setMems(m); await save(STORAGE.memories, m); }, []);
  const persistMeta = useCallback(async (m) => { setMeta(m); await save(STORAGE.meta, m); }, []);
  const persistBriefing = useCallback(async (b) => { setBriefing(b); await save(STORAGE.briefing, b); }, []);

  // ── Boot ──
  useEffect(() => {
    (async () => {
      setBootLog(["◉ Initializing claude-engram..."]);
      const memData = await load(STORAGE.memories);
      const metaData = await load(STORAGE.meta);
      const briefData = await load(STORAGE.briefing);
      const m = memData || [];
      const mt = metaData || { lastConsol: null, created: Date.now() };
      setMems(m); setMeta(mt);
      if (briefData) setBriefing(briefData);
      setBootLog(p => [...p, `✓ Loaded ${m.length} memories`]);

      if (m.length >= 3 && (!mt.lastConsol || daysAgo(mt.lastConsol) >= AUTO_CONSOL_DAYS)) {
        setBootLog(p => [...p, `◉ Auto-consolidation triggered (${mt.lastConsol ? daysAgo(mt.lastConsol).toFixed(1) + 'd since last' : 'never run'})`]);
        const alive = m.filter(mem => strength(mem) > 0.03);
        const pruned = m.length - alive.length;
        if (pruned > 0) setBootLog(p => [...p, `✓ Pruned ${pruned} near-zero memories`]);
        const consolidated = alive.map(mem => {
          if (!mem.consolidated && strength(mem) >= 0.5 && mem.accessCount >= 2) return { ...mem, consolidated: true };
          return mem;
        });
        await save(STORAGE.memories, consolidated); setMems(consolidated);
        const newMeta = { ...mt, lastConsol: Date.now() };
        await save(STORAGE.meta, newMeta); setMeta(newMeta);
        setBootLog(p => [...p, `✓ Auto-consolidation complete. ${consolidated.length} memories active.`]);

        if (consolidated.length > 0) {
          setBootLog(p => [...p, "◉ Generating fresh briefing..."]);
          const sorted = consolidated.map(mem => ({ ...mem, _s: strength(mem) })).sort((a, b) => b._s - a._s);
          const payload = sorted.slice(0, 60).map(mem => ({ content: mem.content, strength: mem._s.toFixed(2), tags: mem.tags, consolidated: mem.consolidated, generalized: mem.generalized }));
          const result = await askClaude(EXPORT_SYS, JSON.stringify(payload));
          if (result) { await save(STORAGE.briefing, result); setBriefing(result); setBootLog(p => [...p, "✓ Briefing ready."]); }
          else { setBootLog(p => [...p, "⚠ Briefing generation failed. Using cached."]); }
        }
      } else if (m.length > 0 && mt.lastConsol) {
        setBootLog(p => [...p, `✓ Next auto-consolidation in ${(AUTO_CONSOL_DAYS - daysAgo(mt.lastConsol)).toFixed(1)}d`]);
      }
      setBootLog(p => [...p, "✓ Ready."]);
      setLoading(false);
    })();
  }, []);

  // ── Ingest ──
  const ingest = async () => {
    if (!rawIn.trim()) return;
    setProcessing(true);
    const sys = mode === "transcript" ? TRANSCRIPT_SYS : INGEST_SYS;
    const existingCtx = mems.length > 0 ? "\n\nEXISTING MEMORIES:\n" + JSON.stringify(mems.slice(0, 50).map(m => ({ id: m.id, content: m.content, tags: m.tags }))) : "";
    setIngestLog(["⟳ Processing..."]);
    const result = await askClaude(sys, rawIn + existingCtx);
    if (!result) { setIngestLog(p => [...p, "✕ API call failed"]); setProcessing(false); return; }

    let parsed;
    try { parsed = repairJSON(result); if (!parsed) throw new Error("Could not parse or repair API response"); }
    catch (e) { setIngestLog(p => [...p, `✕ Parse error: ${e.message}`]); setProcessing(false); return; }

    if (!Array.isArray(parsed)) { setIngestLog(p => [...p, "✕ Expected array"]); setProcessing(false); return; }

    let updated = [...mems]; let updateCount = 0;
    const newMems = [];
    for (const item of parsed) {
      if (item.updates && typeof item.updates === "string") {
        updated = updated.map(m => m.id === item.updates ? { ...m, content: (item.content || m.content).slice(0, 400), salience: item.salience ? sanitizeSalience({ ...m.salience, ...item.salience }, m.salience) : m.salience, tags: item.tags || m.tags, lastAccessed: Date.now(), accessCount: m.accessCount + 1 } : m);
        updateCount++;
      } else {
        newMems.push({
          id: uid(), content: (item.content || "").slice(0, 400),
          salience: { novelty: clamp(item.salience?.novelty, .5), relevance: clamp(item.salience?.relevance, .5), emotional: clamp(item.salience?.emotional, .3), predictive: clamp(item.salience?.predictive, .4) },
          tags: Array.isArray(item.tags) ? item.tags.slice(0, 5) : [],
          accessCount: 0, lastAccessed: null, createdAt: Date.now(), consolidated: false, generalized: false,
        });
      }
    }
    const final = [...newMems, ...updated];
    await persist(final);
    setIngestLog(p => [...p, `✓ Encoded ${newMems.length} new memories`, updateCount > 0 ? `✓ Updated ${updateCount} existing memories` : null, `✓ Total: ${final.length}`].filter(Boolean));
    setRawIn(""); setProcessing(false);
  };

  // ── Consolidation ──
  const consolidate = async () => {
    if (mems.length < 2) return;
    setConsoling(true); setConsolLog(["◉ Starting deep sleep cycle..."]);
    const alive = mems.filter(m => strength(m) > 0.03);
    const autoPruned = mems.length - alive.length;
    if (autoPruned > 0) setConsolLog(p => [...p, `✓ Pruned ${autoPruned} near-zero memories`]);
    const payload = alive.map(m => ({ id: m.id, content: m.content, tags: m.tags, strength: strength(m).toFixed(2), age_days: daysAgo(m.createdAt).toFixed(1), access_count: m.accessCount, consolidated: m.consolidated }));
    setConsolLog(p => [...p, `⟳ Analyzing ${payload.length} memories...`]);
    const result = await askClaude(CONSOL_SYS, JSON.stringify(payload));

    if (!result) {
      setConsolLog(p => [...p, "⚠ API unavailable. Running local consolidation."]);
      const local = alive.map(m => {
        if (!m.consolidated && strength(m) >= .5 && m.accessCount >= 2) return { ...m, consolidated: true };
        if (strength(m) < .25 && !m.consolidated) return { ...m, salience: { ...m.salience, novelty: m.salience.novelty * .7, predictive: m.salience.predictive * .7 } };
        return m;
      });
      await persist(local); await persistMeta({ ...meta, lastConsol: Date.now() });
      setConsolLog(p => [...p, "✓ Local consolidation done."]); setConsoling(false); return;
    }

    let plan;
    try { plan = repairJSON(result); if (!plan) throw new Error("repair failed"); }
    catch { setConsolLog(p => [...p, "⚠ Parse failed, using local fallback."]); await persist(alive); setConsoling(false); return; }

    let updated = [...alive]; let mc = 0, pc = 0, gc = 0;
    if (plan.merge) for (const mg of plan.merge) {
      if (!mg.ids || !mg.merged) continue;
      updated = updated.filter(m => !mg.ids.includes(m.id));
      updated.unshift({ id: uid(), content: (mg.merged.content || "").slice(0, 400), salience: sanitizeSalience(mg.merged.salience, { novelty: .5, relevance: .5, emotional: .3, predictive: .4 }), tags: mg.merged.tags || [], accessCount: 1, lastAccessed: Date.now(), createdAt: Date.now(), consolidated: true, generalized: false }); mc++;
    }
    if (plan.prune_ids) { const b = updated.length; updated = updated.filter(m => !plan.prune_ids.includes(m.id)); pc = b - updated.length; }
    if (plan.generalize) for (const g of plan.generalize) {
      updated.unshift({ id: uid(), content: (g.content || "").slice(0, 400), salience: sanitizeSalience(g.salience, { novelty: .6, relevance: .7, emotional: .3, predictive: .5 }), tags: g.tags || ["pattern"], accessCount: 0, lastAccessed: null, createdAt: Date.now(), consolidated: true, generalized: true }); gc++;
    }
    updated = updated.map(m => (!m.consolidated && strength(m) >= .5 && m.accessCount >= 2) ? { ...m, consolidated: true } : m);
    await persist(updated); await persistMeta({ ...meta, lastConsol: Date.now() });
    setConsolLog(p => [...p, plan.notes ? `◉ ${plan.notes}` : null, `✓ ${mc} merges, ${gc} patterns, ${pc + autoPruned} pruned`, `✓ ${updated.length} memories active`].filter(Boolean));
    setConsoling(false);
  };

  // ── Export ──
  const genBriefing = async () => {
    setExporting(true);
    const sorted = mems.map(m => ({ ...m, _s: strength(m) })).sort((a, b) => b._s - a._s);
    const payload = sorted.slice(0, 60).map(m => ({ content: m.content, strength: m._s.toFixed(2), tags: m.tags, consolidated: m.consolidated, generalized: m.generalized }));
    const result = await askClaude(EXPORT_SYS, JSON.stringify(payload));
    if (result) { await persistBriefing(result); } else {
      const fb = "## Memory Briefing (local)\n\n" + sorted.slice(0, 20).map(m => `- [${sLbl(m._s)}] ${m.content}`).join("\n");
      await persistBriefing(fb);
    }
    setExporting(false);
  };

  // ── Export / Import ──
  const exportData = () => {
    const data = JSON.stringify({ memories: mems, meta, briefing, exportedAt: Date.now(), version: "v3" }, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `claude-engram-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const importData = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (!data.memories || !Array.isArray(data.memories)) {
          showToast("Invalid backup file — no memories array found.", true);
          return;
        }
        showConfirm(`Restore ${data.memories.length} memories from backup? This will replace your current memory bank.`, async () => {
          await persist(data.memories);
          if (data.meta) await persistMeta(data.meta);
          if (data.briefing) await persistBriefing(data.briefing);
          showToast(`Restored ${data.memories.length} memories successfully.`);
          setConfirmDialog(null);
        });
      } catch (err) {
        showToast(`Import failed: ${err.message}`, true);
      }
    };
    input.click();
  };

  const reinforce = id => persist(mems.map(m => m.id === id ? { ...m, accessCount: m.accessCount + 1, lastAccessed: Date.now() } : m));
  const remove = id => { persist(mems.filter(m => m.id !== id)); setExpId(null); };
  const resetAll = () => showConfirm("Wipe ALL memories permanently?", async () => { await persist([]); await persistBriefing(""); await persistMeta({ lastConsol: null, created: Date.now() }); setConfirmDialog(null); showToast("All memories wiped."); });

  const processed = mems.map(m => ({ ...m, _s: strength(m) }))
    .filter(m => !search || m.content.toLowerCase().includes(search.toLowerCase()) || m.tags?.some(t => t.includes(search.toLowerCase())))
    .sort((a, b) => sort === "strength" ? b._s - a._s : sort === "recent" ? b.createdAt - a.createdAt : b.accessCount - a.accessCount);

  const st = {
    total: mems.length,
    avg: mems.length ? mems.reduce((s, m) => s + strength(m), 0) / mems.length : 0,
    con: mems.filter(m => m.consolidated).length,
    pat: mems.filter(m => m.generalized).length,
    dec: mems.filter(m => strength(m) < .2).length,
  };

  // ── Loading screen ──
  if (loading) return (
    <div style={{ minHeight: "100vh", background: colors.bg, display: "flex", flexDirection: "column" }}>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
      <div style={{ maxWidth: 640, width: "100%", margin: "0 auto", padding: "40px 24px", fontFamily: "Inter, system-ui, sans-serif" }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: colors.text, margin: "0 0 24px" }}>claude-engram</h1>
        <div style={{ background: colors.surface, borderRadius: 12, border: `1px solid ${colors.border}`, padding: 20 }}>
          {bootLog.map((l, i) => (
            <div key={i} style={{ fontSize: 13, lineHeight: 1.8, color: l.startsWith("✓") ? colors.green : l.startsWith("◉") ? colors.purple : l.startsWith("⚠") ? colors.accent : colors.textSecondary }}>{l}</div>
          ))}
          <div style={{ marginTop: 10, fontSize: 13, color: colors.purple }}>Loading...</div>
        </div>
      </div>
    </div>
  );

  const tabs = [
    { key: "briefing", label: "Briefing" },
    { key: "bank", label: `Memories (${st.total})` },
    { key: "ingest", label: "Ingest" },
    { key: "sleep", label: "Sleep Cycle" },
  ];

  return (
    <div style={{ minHeight: "100vh", background: colors.bg, fontFamily: "Inter, system-ui, sans-serif" }}>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
      <div style={{ maxWidth: 640, width: "100%", margin: "0 auto", padding: "32px 24px" }}>

        {/* Header */}
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: colors.text, margin: "0 0 4px" }}>claude-engram</h1>
          <p style={{ fontSize: 13, color: colors.textSecondary, margin: 0 }}>Brain-inspired persistent memory with decay, consolidation & pattern extraction</p>
        </div>

        {/* Stats */}
        <div style={{
          display: "flex", gap: 16, padding: "10px 16px", marginBottom: 20,
          background: colors.surface, borderRadius: 10, border: `1px solid ${colors.border}`,
          fontSize: 13, color: colors.textSecondary,
        }}>
          <div><span style={{ color: colors.textSecondary }}>Memories </span><span style={{ color: colors.text, fontWeight: 600 }}>{st.total}</span></div>
          <div><span style={{ color: colors.textSecondary }}>Avg </span><span style={{ color: sCol(st.avg), fontWeight: 600 }}>{(st.avg * 100) | 0}%</span></div>
          <div><span style={{ color: colors.textSecondary }}>Consolidated </span><span style={{ color: colors.green, fontWeight: 600 }}>{st.con}</span></div>
          <div><span style={{ color: colors.textSecondary }}>Patterns </span><span style={{ color: colors.purple, fontWeight: 600 }}>{st.pat}</span></div>
          {st.dec > 0 && <div><span style={{ color: colors.textSecondary }}>Decaying </span><span style={{ color: colors.red, fontWeight: 600 }}>{st.dec}</span></div>}
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 2, marginBottom: 20, background: colors.surface, borderRadius: 10, padding: 3, border: `1px solid ${colors.border}` }}>
          {tabs.map(t => (
            <button key={t.key} onClick={() => setView(t.key)} style={{
              flex: 1, background: view === t.key ? colors.bg : "transparent",
              border: "none", borderRadius: 8,
              color: view === t.key ? colors.text : colors.textSecondary,
              fontSize: 13, fontWeight: view === t.key ? 600 : 500,
              padding: "8px 4px", cursor: "pointer", transition: "all 0.15s",
            }}>{t.label}</button>
          ))}
        </div>

        {/* ═══ BRIEFING ═══ */}
        {view === "briefing" && (
          <div style={{ background: colors.surface, borderRadius: 12, border: `1px solid ${colors.border}`, padding: 24 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h2 style={{ fontSize: 17, fontWeight: 600, color: colors.text, margin: 0 }}>Context Briefing</h2>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={genBriefing} disabled={exporting || mems.length === 0} style={{
                  background: colors.accentMuted, border: `1px solid ${colors.accent}30`,
                  color: mems.length > 0 ? colors.accent : colors.textTertiary,
                  fontSize: 12, fontWeight: 500, padding: "6px 14px", borderRadius: 8, cursor: mems.length > 0 ? "pointer" : "default",
                }}>{exporting ? "Generating..." : "Regenerate"}</button>
                {briefing && <button onClick={() => handleCopy(briefing)} style={{
                  background: colors.greenMuted, border: `1px solid ${colors.green}30`,
                  color: colors.green, fontSize: 12, fontWeight: 500, padding: "6px 14px", borderRadius: 8, cursor: "pointer",
                }}>{copied ? "Copied!" : "Copy"}</button>}
              </div>
            </div>

            <p style={{ fontSize: 13, color: colors.textSecondary, margin: "0 0 16px", lineHeight: 1.5 }}>
              Copy this briefing and paste it at the start of a new Claude conversation to restore context.
            </p>

            {briefing ? (
              <pre style={{
                background: colors.bg, border: `1px solid ${colors.border}`, borderRadius: 10,
                padding: 16, color: colors.textSecondary, fontSize: 13, lineHeight: 1.65,
                whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 440, overflow: "auto", margin: 0,
              }}>{briefing}</pre>
            ) : (
              <div style={{ textAlign: "center", padding: 40, color: colors.textSecondary, fontSize: 13 }}>
                {mems.length === 0 ? "No memories yet. Ingest some first." : "Click Regenerate to create a briefing."}
              </div>
            )}

            {bootLog.length > 0 && (
              <details style={{ marginTop: 16 }}>
                <summary style={{ fontSize: 12, color: colors.textSecondary, cursor: "pointer" }}>Boot log</summary>
                <div style={{ marginTop: 8, padding: 12, background: colors.bg, borderRadius: 8 }}>
                  {bootLog.map((l, i) => <div key={i} style={{ fontSize: 12, lineHeight: 1.7, color: l.startsWith("✓") ? colors.green : l.startsWith("◉") ? colors.purple : l.startsWith("⚠") ? colors.accent : colors.textTertiary }}>{l}</div>)}
                </div>
              </details>
            )}
          </div>
        )}

        {/* ═══ BANK ═══ */}
        {view === "bank" && (
          <div>
            <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
              <input type="text" placeholder="Search memories..." value={search} onChange={e => setSearch(e.target.value)}
                style={{
                  flex: 1, background: colors.surface, border: `1px solid ${colors.border}`, borderRadius: 8,
                  color: colors.text, fontSize: 13, padding: "8px 12px", outline: "none",
                }} />
              <select value={sort} onChange={e => setSort(e.target.value)} style={{
                background: colors.surface, border: `1px solid ${colors.border}`, borderRadius: 8,
                color: colors.textSecondary, fontSize: 12, padding: "6px 10px", cursor: "pointer", outline: "none",
              }}>
                <option value="strength">Strength</option>
                <option value="recent">Recent</option>
                <option value="accessed">Accessed</option>
              </select>
            </div>
            {processed.length === 0 ? (
              <div style={{ textAlign: "center", padding: 40, color: colors.textSecondary, fontSize: 13 }}>
                {mems.length === 0 ? "Empty. Use Ingest to encode memories." : "No matches."}
              </div>
            ) : processed.map(m => (
              <MemCard key={m.id} m={m} open={expId === m.id} onToggle={() => setExpId(expId === m.id ? null : m.id)}
                onReinforce={() => reinforce(m.id)} onDelete={() => remove(m.id)} />
            ))}
          </div>
        )}

        {/* ═══ INGEST ═══ */}
        {view === "ingest" && (
          <div style={{ background: colors.surface, borderRadius: 12, border: `1px solid ${colors.border}`, padding: 24 }}>
            <h2 style={{ fontSize: 17, fontWeight: 600, color: colors.text, margin: "0 0 6px" }}>Ingest Memories</h2>
            <p style={{ fontSize: 13, color: colors.textSecondary, margin: "0 0 16px", lineHeight: 1.5 }}>
              Paste a memory dump or full transcript. The API extracts memories, scores salience, and detects updates.
            </p>

            <div style={{ display: "flex", gap: 4, marginBottom: 14, background: colors.bg, borderRadius: 8, padding: 3 }}>
              {[{ k: "summary", l: "Summary / Dump" }, { k: "transcript", l: "Full Transcript" }].map(o => (
                <button key={o.k} onClick={() => setMode(o.k)} style={{
                  flex: 1, background: mode === o.k ? colors.surface : "transparent",
                  border: "none", borderRadius: 6,
                  color: mode === o.k ? colors.text : colors.textSecondary,
                  fontSize: 12, fontWeight: mode === o.k ? 600 : 500,
                  padding: "6px 8px", cursor: "pointer",
                }}>{o.l}</button>
              ))}
            </div>

            <textarea value={rawIn} onChange={e => setRawIn(e.target.value)}
              placeholder={mode === "transcript" ? "Paste full conversation transcript..." : "Paste memory dump or summary..."}
              rows={8} style={{
                width: "100%", background: colors.bg, border: `1px solid ${colors.border}`, borderRadius: 10,
                color: colors.text, fontSize: 13, padding: 14, resize: "vertical", outline: "none",
                lineHeight: 1.55, boxSizing: "border-box",
              }} />

            <button onClick={ingest} disabled={processing || !rawIn.trim()} style={{
              marginTop: 12, width: "100%", padding: "10px 20px", borderRadius: 10,
              background: !processing && rawIn.trim() ? colors.accent : colors.border,
              border: "none", color: !processing && rawIn.trim() ? "#fff" : colors.textTertiary,
              fontSize: 14, fontWeight: 600, cursor: !processing && rawIn.trim() ? "pointer" : "default",
            }}>{processing ? "Processing..." : "Process & Encode"}</button>

            <LogPanel lines={ingestLog} />
          </div>
        )}

        {/* ═══ SLEEP ═══ */}
        {view === "sleep" && (
          <div style={{ background: colors.surface, borderRadius: 12, border: `1px solid ${colors.border}`, padding: 24 }}>
            <h2 style={{ fontSize: 17, fontWeight: 600, color: colors.text, margin: "0 0 6px" }}>Sleep Consolidation</h2>
            <p style={{ fontSize: 13, color: colors.textSecondary, margin: "0 0 16px", lineHeight: 1.5 }}>
              Deep consolidation: merges redundancies, resolves contradictions, extracts patterns, and prunes dead memories. Auto-runs every {AUTO_CONSOL_DAYS} days.
            </p>

            <div style={{
              padding: 16, background: colors.bg, borderRadius: 10, border: `1px solid ${colors.border}`,
              marginBottom: 16, fontSize: 13, lineHeight: 1.8, color: colors.textSecondary,
            }}>
              <div style={{ color: colors.textSecondary, fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Pre-cycle analysis</div>
              <div style={{ color: colors.green }}>→ {mems.filter(m => strength(m) >= .5 && m.accessCount >= 2 && !m.consolidated).length} ready for consolidation</div>
              <div style={{ color: colors.purple }}>→ {mems.length >= 3 ? "Pattern detection enabled" : "Need 3+ memories"}</div>
              <div style={{ color: colors.accent }}>→ {mems.filter(m => strength(m) < .25).length} below threshold</div>
              <div style={{ color: colors.red }}>→ {mems.filter(m => strength(m) <= .05).length} near-zero</div>
              {meta.lastConsol && <div style={{ color: colors.textSecondary, marginTop: 4 }}>Last cycle: {daysAgo(meta.lastConsol).toFixed(1)} days ago</div>}
            </div>

            <button onClick={consolidate} disabled={consoling || mems.length < 2} style={{
              width: "100%", padding: "10px 20px", borderRadius: 10,
              background: !consoling && mems.length >= 2 ? colors.purple : colors.border,
              border: "none", color: !consoling && mems.length >= 2 ? "#fff" : colors.textTertiary,
              fontSize: 14, fontWeight: 600, cursor: !consoling && mems.length >= 2 ? "pointer" : "default",
            }}>{consoling ? "Consolidating..." : "Run Deep Sleep"}</button>

            <LogPanel lines={consolLog} />
          </div>
        )}

        {/* Footer */}
        <div style={{ marginTop: 28, paddingTop: 16, borderTop: `1px solid ${colors.border}` }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <button onClick={exportData} disabled={mems.length === 0} style={{
              flex: 1, background: colors.blueMuted, border: `1px solid ${colors.blue}30`, color: mems.length > 0 ? colors.blue : colors.textTertiary,
              fontSize: 12, fontWeight: 500, padding: "8px 14px", borderRadius: 8, cursor: mems.length > 0 ? "pointer" : "default",
            }}>↓ Download Backup</button>
            <button onClick={importData} style={{
              flex: 1, background: colors.accentMuted, border: `1px solid ${colors.accent}30`, color: colors.accent,
              fontSize: 12, fontWeight: 500, padding: "8px 14px", borderRadius: 8, cursor: "pointer",
            }}>↑ Restore Backup</button>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 11, color: colors.textSecondary }}>claude-engram v0.3</span>
            <button onClick={resetAll} style={{
              background: "transparent", border: `1px solid ${colors.red}25`, color: colors.red,
              fontSize: 11, padding: "4px 10px", borderRadius: 6, cursor: "pointer", opacity: 0.6,
            }}>Reset All Memories</button>
          </div>
        </div>

        {/* Toast notification */}
        {toast && (
          <div style={{
            position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
            background: toast.isError ? colors.red : colors.green, color: "#fff",
            padding: "10px 20px", borderRadius: 10, fontSize: 13, fontWeight: 500,
            boxShadow: "0 4px 20px rgba(0,0,0,0.4)", zIndex: 999, maxWidth: "90%", textAlign: "center",
          }}>{toast.msg}</div>
        )}

        {/* Confirm dialog */}
        {confirmDialog && (
          <div style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
          }}>
            <div style={{
              background: colors.surface, border: `1px solid ${colors.border}`, borderRadius: 14,
              padding: 24, maxWidth: 360, width: "90%",
            }}>
              <p style={{ color: colors.text, fontSize: 14, lineHeight: 1.55, margin: "0 0 20px" }}>{confirmDialog.msg}</p>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button onClick={() => setConfirmDialog(null)} style={{
                  background: colors.bg, border: `1px solid ${colors.border}`, color: colors.textSecondary,
                  fontSize: 13, fontWeight: 500, padding: "8px 16px", borderRadius: 8, cursor: "pointer",
                }}>Cancel</button>
                <button onClick={confirmDialog.onYes} style={{
                  background: colors.accent, border: "none", color: "#fff",
                  fontSize: 13, fontWeight: 600, padding: "8px 16px", borderRadius: 8, cursor: "pointer",
                }}>Confirm</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function clamp(v, d) { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : d; }

function sanitizeSalience(raw, defaults) {
  if (!raw || typeof raw !== "object") return defaults;
  return {
    novelty: clamp(raw.novelty, defaults.novelty),
    relevance: clamp(raw.relevance, defaults.relevance),
    emotional: clamp(raw.emotional, defaults.emotional),
    predictive: clamp(raw.predictive, defaults.predictive),
  };
}
