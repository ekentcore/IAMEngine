"use client";

// Paste or type a runbook for a client with no ServiceNow KB (e.g. Coretelligent — process lives in
// an internal script). The text is parsed into ordered sections + steps; section headers that match a
// known system (Active Directory, Microsoft 365, Exchange…) get wired to that system automatically.
import { useState } from "react";
import { useRouter } from "next/navigation";

type Section = { seq: number; systemKey: string | null; title: string; status: string; steps: string[] };

export function RunbookEditor({ slug }: { slug: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<"onboard" | "offboard">("onboard");
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<Section[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function call(persist: boolean) {
    setBusy(true); setError(null);
    const r = await fetch(`/api/clients/${slug}/runbook`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, text, preview: !persist }),
    });
    setBusy(false);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setError(d.error ?? `failed (${r.status})`); return; }
    if (persist) { setOpen(false); setPreview(null); router.refresh(); }
    else setPreview(d.sections ?? []);
  }

  if (!open) {
    return <button onClick={() => setOpen(true)} style={{ marginTop: "0.5rem" }}>Paste / edit runbook</button>;
  }

  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 4, padding: "0.75rem", marginTop: "0.5rem" }}>
      <div className="toolbar" style={{ marginBottom: "0.5rem" }}>
        <label htmlFor="rb-action">Action</label>
        <select id="rb-action" value={action} onChange={(e) => { setAction(e.target.value as never); setPreview(null); }}>
          <option value="onboard">onboard</option>
          <option value="offboard">offboard</option>
        </select>
        <span className="note">Headers like “Active Directory”, “Microsoft 365”, “Exchange” auto-map to a system.</span>
      </div>
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
          <p className="note">Preview — {preview.length} section{preview.length === 1 ? "" : "s"} ({preview.filter((s) => s.systemKey).length} mapped to a system):</p>
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
