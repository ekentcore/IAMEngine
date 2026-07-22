"use client";

// Per-request "Send to chat": pick the audience (the All-clients chat, the Restricted chat, or both),
// optionally add a comment, send, and see the per-channel delivery results inline. The server composes
// the actual message (number, title, request text, resolution note) from the request id — the client
// only supplies the audience and the optional comment. Mirrors the change-log SendPanel.
//
// Self-contained (its own fetch + state) so it can drop into both the board Row and the Completed
// table's Controls. It intentionally does NOT use FeatureRequestsAdmin's `send` helper: that one
// returns a FeatureRequestRow, and this endpoint returns per-channel results, not a row.
import { useState } from "react";
import { frNumber } from "@/lib/feature-requests/visibility";

type Audience = "all" | "restricted" | "both";
type ChannelResult = { channel: string; ok: boolean; error?: string };

const AUDIENCES: { key: Audience; label: string; help: string }[] = [
  { key: "all", label: "All clients chat", help: "Each channel's default destination" },
  { key: "restricted", label: "Restricted chat", help: "Each channel's restricted destination" },
  { key: "both", label: "Both", help: "Default + restricted (de-duplicated)" },
];

export function FrSendToChatPanel({ id, number, onClose }: { id: string; number: number; onClose: () => void }) {
  const [audience, setAudience] = useState<Audience>("all");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<ChannelResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setBusy(true); setError(null); setResults(null);
    try {
      const res = await fetch(`/api/admin/feature-requests/${id}/announce`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audience, comment: comment.trim() || undefined }),
      });
      // Parse defensively BEFORE the ok-check: a 500/502 may be an HTML error page, and a JSON parse
      // throw here would mask the real status with "Unexpected token <".
      const data = (await res.json().catch(() => ({}))) as { results?: ChannelResult[]; error?: string };
      if (!res.ok) { setError(data.error ?? `HTTP ${res.status}`); return; }
      setResults(data.results ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 10, padding: "0.7rem 0.85rem", border: "1px solid var(--line, #e5e7eb)", borderRadius: 10, whiteSpace: "normal" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "center" }}>
        <b style={{ fontSize: 13 }}>Send {frNumber(number)} to chat</b>
        {AUDIENCES.map((a) => (
          <label key={a.key} title={a.help} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 13, cursor: "pointer" }}>
            <input type="radio" name={`fr-aud-${id}`} checked={audience === a.key} onChange={() => setAudience(a.key)} style={{ width: "auto" }} />
            {a.label}
          </label>
        ))}
      </div>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Optional comment — shown above the request"
        rows={2}
        maxLength={2000}
        style={{ width: "100%", marginTop: 8, fontSize: 13 }}
      />
      <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
        <button type="button" onClick={send} disabled={busy}>{busy ? "Sending…" : "Send"}</button>
        <button type="button" onClick={onClose} disabled={busy}>Close</button>
        {error && <span className="note" style={{ color: "#b3261e" }}>{error}</span>}
      </div>
      {results && (
        <p className="note" style={{ marginTop: 8, marginBottom: 0 }}>
          {results.length === 0
            ? "Nothing sent — no chat destinations are configured (and enabled) for this audience in Settings."
            : results.map((r, i) => (
                <span key={i} style={{ marginRight: 10 }}>
                  {r.ok ? "✓" : "✕"} {r.channel}{r.ok ? "" : ` — ${r.error ?? "failed"}`}
                </span>
              ))}
        </p>
      )}
    </div>
  );
}

// Combined button + inline panel-below, for the board Row (rendered on its own line under the row's
// controls). The Completed table drives the panel itself (a full-width spanning table row), so it
// imports FrSendToChatPanel directly rather than this.
export function FrSendToChat({ id, number }: { id: string; number: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen((v) => !v)}>
        {open ? "Cancel send to chat" : "Send to chat"}
      </button>
      {open && <FrSendToChatPanel id={id} number={number} onClose={() => setOpen(false)} />}
    </div>
  );
}
