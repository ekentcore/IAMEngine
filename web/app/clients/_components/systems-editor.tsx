"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { CATALOG } from "@/lib/generator/system-map";

type Lane = "always" | "on_request" | "never";
type Mode = "api" | "browser" | "manual";
type Row = {
  systemKey: string;
  mode: Mode;
  onboardWhen: Lane;
  offboardWhen: Lane;
  dependsOn: string[];
  requiresApproval: boolean;
  captureEvidence: boolean;
  secretNames: string[];
  configText: string; // JSON text; parsed on save
};

const BACKBONES = [
  { v: "", label: "— not modeled —" },
  { v: "entra", label: "Entra" },
  { v: "google", label: "Google" },
  { v: "ad_synced", label: "AD synced" },
  { v: "ad_standalone", label: "AD standalone" },
];
const LANES: Lane[] = ["always", "on_request", "never"];
const MODES: Mode[] = ["api", "browser", "manual"];
// Color the lane selects so onboard/offboard participation is scannable at a glance: green = runs,
// amber = only on request, grey = off. (Flat tints, no gradients — matches the host design system.)
const LANE_STYLE: Record<Lane, CSSProperties> = {
  always: { background: "#e8f5ee", color: "#15803d", borderColor: "#bbf7d0" },
  on_request: { background: "#fef6e7", color: "#92400e", borderColor: "#fde9c8" },
  never: { background: "#f4f4f5", color: "#9ca3af", borderColor: "#e5e7eb" },
};
const cell: CSSProperties = { padding: "5px 8px", verticalAlign: "top" };
const ALL_KEYS = Object.keys(CATALOG).sort();
const mapLane = (l: string | null): Lane => (l === "on-request" ? "on_request" : l === "always" ? "always" : "never");

function rowFromCatalog(key: string): Row {
  const c = CATALOG[key];
  return {
    systemKey: key,
    mode: (c?.mode ?? "api") as Mode,
    onboardWhen: mapLane(c?.onboard ?? null),
    offboardWhen: mapLane(c?.offboard ?? null),
    dependsOn: [],
    requiresApproval: false,
    captureEvidence: false,
    secretNames: c?.secret ? [c.secret] : [],
    configText: "",
  };
}

export function SystemsEditor({ slug, open, onClose }: { slug: string | null; open: boolean; onClose: () => void }) {
  const router = useRouter();
  const ref = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<"manual" | "parse" | "kb">("manual");
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState("");
  const [backbone, setBackbone] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [addKey, setAddKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // parse tab
  const [paste, setPaste] = useState("");
  const [useAI, setUseAI] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [parsed, setParsed] = useState<{ systems: string[]; backbone: string; unmodeled: string[]; usedAI: boolean } | null>(null);
  // kb tab
  const [kb, setKb] = useState<{ onboard: { html: string; markdown: string }; offboard: { html: string; markdown: string } } | null>(null);

  useEffect(() => {
    if (open && slug) {
      if (!ref.current?.open) ref.current?.showModal();
      void load(slug);
    } else if (!open) {
      ref.current?.open && ref.current.close();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, slug]);

  async function load(s: string) {
    setLoading(true); setError(null); setTab("manual"); setParsed(null); setKb(null); setPaste("");
    try {
      const res = await fetch(`/api/clients/${s}`);
      const c = await res.json();
      setName(c.name ?? s);
      setBackbone(c.backbone ?? "");
      setRows(
        (c.systems ?? []).map((sys: Record<string, unknown>) => ({
          systemKey: sys.systemKey,
          mode: sys.mode,
          onboardWhen: sys.onboardWhen,
          offboardWhen: sys.offboardWhen,
          // round-trip dependsOn — without this, every save wiped it and broke topo-ordering
          dependsOn: Array.isArray(sys.dependsOn) ? sys.dependsOn : [],
          requiresApproval: Boolean(sys.requiresApproval),
          captureEvidence: Boolean(sys.captureEvidence),
          secretNames: Array.isArray(sys.secretNames) ? sys.secretNames : [],
          configText: sys.config ? JSON.stringify(sys.config, null, 2) : "",
        }))
      );
    } finally {
      setLoading(false);
    }
  }

  function update(i: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }
  function remove(i: number) {
    setRows((rs) => rs.filter((_, j) => j !== i));
  }
  function addSystem(key: string) {
    if (!key || rows.some((r) => r.systemKey === key)) return;
    setRows((rs) => [...rs, rowFromCatalog(key)]);
    setAddKey("");
  }

  async function save() {
    setSaving(true); setError(null);
    // validate config JSON
    const systems = [];
    for (const r of rows) {
      let config: unknown = null;
      if (r.configText.trim()) {
        try { config = JSON.parse(r.configText); }
        catch { setError(`Invalid JSON config for ${r.systemKey}`); setSaving(false); return; }
      }
      systems.push({ ...r, secretNames: r.secretNames, config });
    }
    try {
      const res = await fetch(`/api/clients/${slug}/systems`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ systems, backbone: backbone || null }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? res.statusText); }
      else { router.refresh(); onClose(); }
    } finally {
      setSaving(false);
    }
  }

  async function runParse() {
    setParsing(true); setParsed(null);
    try {
      const res = await fetch(`/api/clients/${slug}/parse`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: paste, useAI }),
      });
      setParsed(await res.json());
    } finally {
      setParsing(false);
    }
  }
  function applyParsed() {
    if (!parsed) return;
    setRows((rs) => {
      const have = new Set(rs.map((r) => r.systemKey));
      const add = parsed.systems.filter((k) => CATALOG[k] && !have.has(k)).map(rowFromCatalog);
      return [...rs, ...add];
    });
    if (parsed.backbone) setBackbone(mapBackbone(parsed.backbone));
    setTab("manual");
  }

  async function genKb() {
    const res = await fetch(`/api/clients/${slug}/kb`);
    setKb(await res.json());
  }

  return (
    <dialog ref={ref} onClose={onClose} style={{ width: 1080, maxWidth: "96vw" }}>
      <div className="row-between">
        <h2>Edit systems — {name}</h2>
        <button onClick={onClose}>Close</button>
      </div>

      <div className="toolbar" style={{ marginTop: "0.5rem" }}>
        <button className={tab === "manual" ? "primary" : ""} onClick={() => setTab("manual")}>Manual</button>
        <button className={tab === "parse" ? "primary" : ""} onClick={() => setTab("parse")}>Parse instructions</button>
        <button className={tab === "kb" ? "primary" : ""} onClick={() => { setTab("kb"); if (!kb) void genKb(); }}>KB article</button>
      </div>

      {loading && <p className="note"><span className="spinner" />Loading…</p>}

      {!loading && tab === "manual" && (
        <div>
          <div className="filters">
            <label style={{ margin: 0 }}>Backbone</label>
            <select className="inline" value={backbone} onChange={(e) => setBackbone(e.target.value)}>
              {BACKBONES.map((b) => <option key={b.v} value={b.v}>{b.label}</option>)}
            </select>
            <span className="grow" />
            <select className="inline" value={addKey} onChange={(e) => setAddKey(e.target.value)}>
              <option value="">add system…</option>
              {ALL_KEYS.filter((k) => !rows.some((r) => r.systemKey === k)).map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <button onClick={() => addSystem(addKey)} disabled={!addKey}>Add</button>
          </div>

          <p className="note" style={{ margin: "0.4rem 0 0.3rem" }}>
            <b>Onboard</b> and <b>Offboard</b> are the two runbooks — set when each system runs:{" "}
            <span className="badge" style={LANE_STYLE.always}>always</span>{" "}
            <span className="badge" style={LANE_STYLE.on_request}>on request</span>{" "}
            <span className="badge" style={LANE_STYLE.never}>never</span>. (e.g. for xMatters onboarding-only: Onboard = always, Offboard = never.)
          </p>
          <div style={{ overflowX: "auto", border: "1px solid var(--line, #e5e7eb)", borderRadius: 8 }}>
            <table style={{ margin: 0, fontSize: 13, minWidth: 920 }}>
              <thead>
                <tr style={{ background: "var(--bg-soft, #f9fafb)" }}>
                  <th style={cell}>System</th>
                  <th style={cell}>Mode</th>
                  <th style={cell}>Onboard</th>
                  <th style={cell}>Offboard</th>
                  <th style={cell}>Depends on</th>
                  <th style={{ ...cell, textAlign: "center" }} title="Destructive step — gated server-side until approved">Approval</th>
                  <th style={{ ...cell, textAlign: "center" }} title="Snapshot the before-state and attach it to the case before any change">Evidence</th>
                  <th style={cell}>Secrets</th>
                  <th style={cell}>Config (JSON)</th>
                  <th style={cell} aria-label="remove"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.systemKey} style={{ borderTop: "1px solid var(--line-2, #f1f5f9)" }}>
                    <td style={{ ...cell, fontFamily: "monospace", fontWeight: 600, whiteSpace: "nowrap" }}>{r.systemKey}</td>
                    <td style={cell}><select value={r.mode} onChange={(e) => update(i, { mode: e.target.value as Mode })}>{MODES.map((m) => <option key={m}>{m}</option>)}</select></td>
                    <td style={cell}><select value={r.onboardWhen} onChange={(e) => update(i, { onboardWhen: e.target.value as Lane })} style={{ ...LANE_STYLE[r.onboardWhen], fontWeight: 600 }}>{LANES.map((l) => <option key={l} value={l}>{l.replace("_", " ")}</option>)}</select></td>
                    <td style={cell}><select value={r.offboardWhen} onChange={(e) => update(i, { offboardWhen: e.target.value as Lane })} style={{ ...LANE_STYLE[r.offboardWhen], fontWeight: 600 }}>{LANES.map((l) => <option key={l} value={l}>{l.replace("_", " ")}</option>)}</select></td>
                    <td style={cell}><input value={r.dependsOn.join(", ")} onChange={(e) => update(i, { dependsOn: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} placeholder="—" style={{ width: 110 }} /></td>
                    <td style={{ ...cell, textAlign: "center" }}><input type="checkbox" style={{ width: "auto" }} checked={r.requiresApproval} onChange={(e) => update(i, { requiresApproval: e.target.checked })} /></td>
                    <td style={{ ...cell, textAlign: "center" }}><input type="checkbox" style={{ width: "auto" }} checked={r.captureEvidence} onChange={(e) => update(i, { captureEvidence: e.target.checked })} /></td>
                    <td style={cell}><input value={r.secretNames.join(", ")} onChange={(e) => update(i, { secretNames: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} placeholder="—" style={{ width: 120 }} /></td>
                    <td style={cell}><textarea value={r.configText} onChange={(e) => update(i, { configText: e.target.value })} placeholder="{ }" rows={2} style={{ width: 220, fontFamily: "monospace", fontSize: 12 }} /></td>
                    <td style={{ ...cell, textAlign: "center" }}><button title={`Remove ${r.systemKey}`} onClick={() => remove(i)}>✕</button></td>
                  </tr>
                ))}
                {rows.length === 0 && <tr><td colSpan={10} className="muted" style={{ textAlign: "center", padding: "1rem" }}>No systems. Add one or use “Parse instructions”.</td></tr>}
              </tbody>
            </table>
          </div>

          {error && <p className="note danger">{error}</p>}
          <div className="dialog-actions">
            <button onClick={onClose} disabled={saving}>Cancel</button>
            <button className="primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save changes"}</button>
          </div>
        </div>
      )}

      {!loading && tab === "parse" && (
        <div>
          <p className="note">Paste the runbook (HTML or text). Detected systems are merged into the manual editor — review before saving.</p>
          <textarea value={paste} onChange={(e) => setPaste(e.target.value)} rows={8} placeholder="Paste ServiceNow KB runbook…" style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }} />
          <div className="toolbar" style={{ marginTop: "0.5rem" }}>
            <label style={{ display: "flex", gap: "0.4rem", alignItems: "center", margin: 0 }}>
              <input type="checkbox" style={{ width: "auto" }} checked={useAI} onChange={(e) => setUseAI(e.target.checked)} /> use AI
            </label>
            <button className="primary" onClick={runParse} disabled={parsing || !paste.trim()}>{parsing ? "Detecting…" : "Detect systems"}</button>
          </div>
          {parsed && (
            <div style={{ marginTop: "0.75rem" }}>
              <p className="note">Backbone: <strong>{parsed.backbone}</strong> · detected {parsed.systems.length} systems {parsed.usedAI ? "(AI)" : "(heuristic)"}</p>
              <p>{parsed.systems.map((s) => <span key={s} className="badge" style={{ marginRight: 4 }}>{s}</span>)}</p>
              {parsed.unmodeled.length > 0 && <p className="note">not modeled: {parsed.unmodeled.slice(0, 12).join(", ")}</p>}
              <button className="primary" onClick={applyParsed}>Add detected → manual</button>
            </div>
          )}
        </div>
      )}

      {!loading && tab === "kb" && (
        <div>
          <p className="note">Rendered from the <em>saved</em> systems. Save first to reflect edits. Paste into a ServiceNow KB article.</p>
          {!kb ? <p className="note"><span className="spinner" />Rendering…</p> : (
            <div style={{ display: "grid", gap: "0.75rem" }}>
              {(["onboard", "offboard"] as const).map((action) => (
                <div key={action}>
                  <strong>{action}</strong>
                  <CopyBox label="HTML" text={kb[action].html} />
                  <CopyBox label="Markdown" text={kb[action].markdown} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </dialog>
  );
}

function CopyBox({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ marginTop: "0.25rem" }}>
      <div className="row-between">
        <span className="note">{label}</span>
        <button onClick={() => { navigator.clipboard?.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <textarea readOnly value={text} rows={5} style={{ width: "100%", fontFamily: "monospace", fontSize: 11 }} />
    </div>
  );
}

function mapBackbone(b: string): string {
  return b === "ad-synced" ? "ad_synced" : b === "ad-standalone" ? "ad_standalone" : b;
}
