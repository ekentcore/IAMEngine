"use client";
import { useState } from "react";

type Suggestion = {
  secretId: number; name: string; folderPath: string; folderId: number | null;
  template?: string; note?: string; score: number; reasons: string[];
};

export function DelineaSuggestions({ slug, secretName, onPick }: { slug: string; secretName: string; onPick: (externalId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<Suggestion[] | null>(null);
  const [folderResolved, setFolderResolved] = useState(true);
  const [showAll, setShowAll] = useState(false);

  async function load() {
    setOpen(true); setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/clients/${slug}/delinea-suggestions?secret=${encodeURIComponent(secretName)}`);
      const d = await r.json();
      if (!r.ok) { setError(d?.error ?? `failed (${r.status})`); return; }
      setFolderResolved(d.folderResolved !== false);
      setItems(d.suggestions ?? []);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const shown = items ? (showAll ? items : items.slice(0, 5)) : [];
  return (
    <div style={{ marginTop: 4 }}>
      <button type="button" className="note" onClick={() => (open ? setOpen(false) : load())}>
        {open ? "Hide suggestions" : "🔎 Suggest from Delinea"}
      </button>
      {open && (
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 6, padding: 8, marginTop: 4 }}>
          {busy && <p className="note"><span className="spinner" /> Searching this client's Delinea folders…</p>}
          {error && <p className="note danger">{error}</p>}
          {!busy && !error && !folderResolved && <p className="note">No Delinea folder is known for this client yet — enter the id by hand, or set the client's folder.</p>}
          {!busy && !error && folderResolved && items?.length === 0 && <p className="note">No matching secrets found in this client's folders.</p>}
          {shown.map((s) => (
            <div key={s.secretId} style={{ borderTop: "1px solid #f0f0f0", padding: "6px 0" }}>
              <div className="row-between">
                <b style={{ fontSize: 13 }}>{s.name}</b>
                <button type="button" className="primary" onClick={() => { onPick(String(s.secretId)); setOpen(false); }}>Use #{s.secretId}</button>
              </div>
              <div className="note" style={{ fontSize: 12 }}>
                <code style={{ fontSize: 11 }}>{s.folderPath}</code>{s.folderId ? ` (folder ${s.folderId})` : ""}{s.template ? ` · ${s.template}` : ""}
              </div>
              {s.note && <div className="note" style={{ fontSize: 12, fontStyle: "italic" }}>note: {s.note}</div>}
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 2 }}>
                {s.reasons.map((r, i) => <span key={i} className="badge" style={{ fontSize: 10 }}>{r}</span>)}
              </div>
            </div>
          ))}
          {items && items.length > 5 && !showAll && (
            <button type="button" className="note" onClick={() => setShowAll(true)} style={{ marginTop: 6 }}>browse all {items.length} in this client's folders</button>
          )}
        </div>
      )}
    </div>
  );
}
