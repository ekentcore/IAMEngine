"use client";

// Change-log entries with a per-entry "Send to chat" flow: pick the audience (the All-clients
// chat, the Restricted chat, or both), optionally add a comment on top, send, and see the
// per-channel delivery results inline. The server composes the actual message from the entry id —
// the client never supplies the content.
import { useState } from "react";
import { formatChangelogWhen, type ChangelogEntry } from "@/lib/changelog/entries";
import { StarWarsEgg } from "./starwars-egg";
import { PirateEgg } from "./pirate-egg";
import { AirhornEgg } from "./airhorn-egg";

type Audience = "all" | "restricted" | "both";
type ChannelResult = { channel: string; ok: boolean; error?: string };

const AUDIENCES: { key: Audience; label: string; help: string }[] = [
  { key: "all", label: "All clients chat", help: "Each channel's default destination" },
  { key: "restricted", label: "Restricted chat", help: "Each channel's restricted destination" },
  { key: "both", label: "Both", help: "Default + restricted (de-duplicated)" },
];

function SendPanel({ entry, onClose }: { entry: ChangelogEntry; onClose: () => void }) {
  const [audience, setAudience] = useState<Audience>("all");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<ChannelResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setBusy(true); setError(null); setResults(null);
    try {
      const res = await fetch("/api/admin/changelog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entryId: entry.id, audience, comment: comment.trim() || undefined }),
      });
      // Parse defensively BEFORE the ok-check: a 500/502 may be an HTML error page, and a JSON
      // parse throw here would mask the real status with "Unexpected token <".
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
    <div style={{ marginTop: 10, padding: "0.7rem 0.85rem", border: "1px solid var(--line, #e5e7eb)", borderRadius: 10 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "center" }}>
        <b style={{ fontSize: 13 }}>Send to chat</b>
        {AUDIENCES.map((a) => (
          <label key={a.key} title={a.help} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 13, cursor: "pointer" }}>
            <input type="radio" name={`aud-${entry.id}`} checked={audience === a.key} onChange={() => setAudience(a.key)} style={{ width: "auto" }} />
            {a.label}
          </label>
        ))}
      </div>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Optional comment — shown above the update"
        rows={2}
        maxLength={2000}
        style={{ width: "100%", marginTop: 8, fontSize: 13 }}
      />
      <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
        <button onClick={send} disabled={busy}>{busy ? "Sending…" : "Send"}</button>
        <button onClick={onClose} disabled={busy}>Close</button>
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

export function ChangelogView({ entries }: { entries: ChangelogEntry[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <div style={{ display: "grid", gap: 12, marginTop: "0.6rem" }}>
      <StarWarsEgg entries={entries} />
      <PirateEgg entries={entries} />
      <AirhornEgg />
      {entries.map((e, i) => (
        // ah-newest: egg-only hook for the airhorn egg — inert until body.airhorn-mode.
        <section key={e.id} className={i === 0 ? "ah-newest" : undefined} style={{ border: "1px solid var(--line, #e5e7eb)", borderRadius: 10, padding: "0.75rem 0.9rem" }}>
          <div className="row-between" style={{ alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <b>{e.title}</b>
            <span style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
              <span className="note">{formatChangelogWhen(e)}</span>
              <button style={{ fontSize: 12 }} onClick={() => setOpenId(openId === e.id ? null : e.id)}>
                {openId === e.id ? "Cancel" : "Send to chat"}
              </button>
            </span>
          </div>
          <ul style={{ margin: "0.45rem 0 0", paddingLeft: "1.15rem" }}>
            {e.items.map((it, i) => <li key={i} style={{ fontSize: 13.5, marginTop: 2 }}>{it}</li>)}
          </ul>
          {openId === e.id && <SendPanel entry={e} onClose={() => setOpenId(null)} />}
        </section>
      ))}
    </div>
  );
}
