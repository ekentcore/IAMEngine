"use client";

// Feature-request triage on /settings (settings.manage): each request shows title, body, who filed
// it, from which page, and when. The status select PATCHes immediately; the resolution note saves
// on blur (only when changed).
import { useState } from "react";

export type FeatureRequestRow = {
  id: string;
  title: string;
  body: string;
  page: string;
  status: string;
  resolutionNote: string | null;
  authorEmail: string | null;
  createdAt: string; // ISO — serialized by the page loader
};

const STATUSES = ["new", "planned", "building", "done", "declined"];

function Row({ initial }: { initial: FeatureRequestRow }) {
  const [req, setReq] = useState(initial);
  const [note, setNote] = useState(initial.resolutionNote ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function patch(data: { status?: string; resolutionNote?: string | null }) {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/feature-requests/${req.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
      });
      const d = (await r.json().catch(() => ({}))) as FeatureRequestRow & { error?: string };
      if (!r.ok) { setErr(d.error ?? `failed (${r.status})`); return; }
      setReq(d);
      setNote(d.resolutionNote ?? "");
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "0.7rem 0.9rem", marginBottom: "0.6rem" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <strong>{req.title}</strong>
        <span className="note">
          {req.authorEmail ?? "unknown"} · {req.page || "/"} · {new Date(req.createdAt).toLocaleString()}
        </span>
      </div>
      {req.body && <p style={{ margin: "0.35rem 0 0", whiteSpace: "pre-wrap" }}>{req.body}</p>}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: "0.55rem", flexWrap: "wrap" }}>
        <select
          value={req.status}
          disabled={busy}
          onChange={(e) => void patch({ status: e.target.value })}
        >
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <input
          value={note}
          disabled={busy}
          placeholder="Resolution note (optional)"
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => { if (note.trim() !== (req.resolutionNote ?? "")) void patch({ resolutionNote: note.trim() === "" ? null : note.trim() }); }}
          style={{ flex: "1 1 220px", minWidth: 180 }}
        />
        {busy && <span className="note">saving…</span>}
        {err && <span className="note" style={{ color: "#b3261e" }}>{err}</span>}
      </div>
    </div>
  );
}

export function FeatureRequestsAdmin({ initial }: { initial: FeatureRequestRow[] }) {
  if (initial.length === 0) return <p className="note">No feature requests yet — the 💡 button in the header files one.</p>;
  return (
    <div>
      {initial.map((r) => <Row key={r.id} initial={r} />)}
    </div>
  );
}
