"use client";

// Paste or type a runbook for a client with no ServiceNow KB (e.g. Coretelligent — process lives in
// an internal script). The text is parsed into ordered sections + steps; section headers that match a
// known system (Active Directory, Microsoft 365, Exchange…) get wired to that system automatically.
import { useState } from "react";
import { useRouter } from "next/navigation";

type Section = { seq: number; systemKey: string | null; title: string; status: string; steps: string[] };

type KbRef = { number: string; action: "onboard" | "offboard" };

export function RunbookEditor({ slug, kbArticles = [] }: { slug: string; kbArticles?: KbRef[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<"onboard" | "offboard">("onboard");
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<Section[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imported, setImported] = useState<{ number: string; title: string; text: string }[] | null>(null);
  const [useAI, setUseAI] = useState(true);
  const [usedAI, setUsedAI] = useState(false);
  // The action this content was fetched/detected as — auto-selected, and the basis for the
  // override warning so a KB isn't accidentally saved to the wrong action's runbook.
  const [detectedAction, setDetectedAction] = useState<"onboard" | "offboard" | null>(null);

  async function call(persist: boolean, overrideText?: string, overrideAction?: "onboard" | "offboard") {
    const t = overrideText ?? text;
    const a = overrideAction ?? action;
    setBusy(true); setError(null);
    const r = await fetch(`/api/clients/${slug}/runbook`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: a, text: t, preview: !persist, useAI }),
    });
    setBusy(false);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setError(d.error ?? `failed (${r.status})`); return; }
    setUsedAI(Boolean(d.usedAI));
    if (persist) { setOpen(false); setPreview(null); router.refresh(); }
    else setPreview(d.sections ?? []);
  }

  // Pull the article's CURRENT body from ServiceNow into the textarea — then the normal
  // parse-preview -> save flow applies (a KB edit never silently rewrites the client).
  async function fetchKb(kb: KbRef) {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/clients/${slug}/runbook/kb-text?article=${encodeURIComponent(kb.number)}`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error ?? `failed (${r.status})`); return; }
      setText(d.text ?? "");
      setAction(kb.action);          // this KB belongs to that action — select it automatically
      setDetectedAction(kb.action);  // and remember it, so flipping the action warns
      setPreview(null); setImported(null);
    } finally {
      setBusy(false);
    }
  }

  // Import the KB body from an uploaded ServiceNow JSON export (records[].text) — same parse-preview
  // -> save flow, but sourced from a file when the integration account can't read kb_knowledge.
  async function importJson(file: File) {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/clients/${slug}/runbook/kb-json`, { method: "POST", body: await file.text() });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error ?? `failed (${r.status})`); return; }
      const records: { number: string; title: string; text: string; detectedAction?: "onboard" | "offboard" | null }[] = d.records ?? [];
      setImported(records);
      const t = records[0]?.text ?? "";
      setText(t);
      setPreview(null);
      // Auto-select the detected action (onboard/offboard) so the KB isn't saved to the wrong one.
      const det = records[0]?.detectedAction ?? null;
      setDetectedAction(det);
      const act = det ?? action;
      if (det) setAction(det);
      // Immediately show the structured preview (AI when enabled) so the operator sees the result.
      if (t.trim()) await call(false, t, act);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return <button onClick={() => setOpen(true)} style={{ marginTop: "0.5rem" }}>Paste / edit runbook</button>;
  }

  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 4, padding: "0.75rem", marginTop: "0.5rem" }}>
      {kbArticles.length > 0 && (
        <div className="toolbar" style={{ marginBottom: "0.5rem" }}>
          <span className="note">KB changed in ServiceNow?</span>
          {kbArticles.map((a) => (
            <button key={a.number} disabled={busy} onClick={() => fetchKb(a)} title={`Fetch ${a.number} (${a.action}) from ServiceNow into the editor`}>
              ⟳ Fetch {a.number} <span className="note" style={{ fontSize: 10 }}>({a.action})</span>
            </button>
          ))}
          <span className="note muted">then Preview the parse and Save to update the runbook + systems</span>
        </div>
      )}
      <div className="toolbar" style={{ marginBottom: "0.5rem" }}>
        <span className="note">Can&rsquo;t read the KB? Import a ServiceNow JSON export:</span>
        <label className="button" style={{ display: "inline-flex", alignItems: "center", padding: "0.26rem 0.6rem", fontSize: 12, border: "1px solid var(--line-2)", borderRadius: 8, cursor: busy ? "default" : "pointer", background: "var(--bg)" }}>
          ⬆ Import KB JSON
          <input type="file" accept=".json,application/json" disabled={busy} style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) importJson(f); e.target.value = ""; }} />
        </label>
        {imported && imported.length > 1 && (
          <select disabled={busy} style={{ width: "auto", fontSize: 12 }} onChange={(e) => { setText(imported[Number(e.target.value)]?.text ?? ""); setPreview(null); }}>
            {imported.map((r, i) => <option key={i} value={i}>{r.number || `record ${i + 1}`}{r.title ? ` — ${r.title}` : ""}</option>)}
          </select>
        )}
        {imported && <span className="note muted">loaded {imported[0]?.number || "KB"}{imported.length > 1 ? ` (+${imported.length - 1} more — pick above)` : ""} — Preview &amp; Save below</span>}
      </div>
      <div className="toolbar" style={{ marginBottom: "0.5rem" }}>
        <label htmlFor="rb-action">Action</label>
        <select id="rb-action" value={action} onChange={(e) => { setAction(e.target.value as never); setPreview(null); }}>
          <option value="onboard">onboard</option>
          <option value="offboard">offboard</option>
        </select>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, margin: 0, color: "var(--fg)" }} title="Use Azure OpenAI to structure messy KB text into sections mapped to systems (recommended for imported KBs)">
          <input type="checkbox" checked={useAI} onChange={(e) => { setUseAI(e.target.checked); setPreview(null); }} style={{ width: "auto" }} />
          ✨ Use AI to detect sections
        </label>
        <span className="note">Headers like “Active Directory”, “Microsoft 365”, “Exchange” auto-map to a system.</span>
      </div>
      {detectedAction && action !== detectedAction && (
        <p className="note" style={{ color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: "0.45rem 0.65rem", margin: "0 0 0.5rem" }}>
          ⚠ This article looks like an <b>{detectedAction}</b> runbook, but you’ve set the action to <b>{action}</b>.
          Saving will write it to the <b>{action}</b> runbook — switch back to <b>{detectedAction}</b> unless this is intentional.
        </p>
      )}
      <textarea value={text} onChange={(e) => { setText(e.target.value); setPreview(null); }} rows={12}
        placeholder={`Active Directory\n- create the user in OU=...\n- add to base groups\n\nMicrosoft 365\n- assign the license\n\nOrder equipment\n- email procurement`}
        style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }} />
      {error && <p className="note danger">{error}</p>}
      <div className="toolbar" style={{ marginTop: "0.5rem" }}>
        <button onClick={() => call(false)} disabled={busy || !text.trim()}>Preview</button>
        <button className="primary" onClick={() => call(true)} disabled={busy || !text.trim()}>{busy ? "Saving…" : "Save runbook"}</button>
        <span className="grow" />
        <button onClick={() => { setOpen(false); setPreview(null); }}>Cancel</button>
      </div>
      {preview && (
        <div style={{ marginTop: "0.6rem" }}>
          <p className="note">Preview — {preview.length} section{preview.length === 1 ? "" : "s"} ({preview.filter((s) => s.systemKey).length} mapped to a system){usedAI ? " · ✨ structured by AI" : useAI ? " · AI unavailable, used heuristic parse" : ""}:</p>
          {preview.map((s) => (
            <div key={s.seq} style={{ margin: "0.3rem 0" }}>
              <b>{s.seq + 1}. {s.title}</b>{" "}
              <span className="badge" style={{ color: s.systemKey ? "#2e7d32" : "var(--muted)" }}>{s.systemKey ?? "unmodeled"}</span>
              <ul className="muted" style={{ margin: "0.2rem 0" }}>{s.steps.map((st, i) => <li key={i} style={{ marginLeft: (st.match(/^ */)?.[0].length ?? 0) * 6 }}>{st.trim()}</li>)}</ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
