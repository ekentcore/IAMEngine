"use client";

// Operator-confirmed hard-match: the consistency check flagged that this hire's on-prem object won't
// link to an existing Entra object. Clicking confirms, then dispatches an on-prem job that writes
// mS-DS-ConsistencyGuid = the cloud immutableId so AAD Connect links them (no auto-write without this
// confirmation). Human-in-the-loop by design.
import { useState } from "react";
import { useRouter } from "next/navigation";

export function HardMatchButton({ caseId }: { caseId: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function run() {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`/api/cases/${caseId}/hard-match`, { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg({ ok: false, text: d.error ?? `failed (${r.status})` }); return; }
      setConfirming(false);
      setMsg({ ok: true, text: "Hard-match queued — the client agent will set the anchor; run a directory-sync to link them." });
      router.refresh();
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    finally { setBusy(false); }
  }

  return (
    <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
      <button onClick={() => setConfirming(true)} style={{ borderColor: "var(--warn-fg)", color: "var(--warn-fg)" }}
        title="A duplicate risk was flagged. Link this hire's on-prem account to the existing Entra object (writes mS-DS-ConsistencyGuid).">
        ⚠ Link to existing Entra account
      </button>
      {msg && <span className="note" style={{ color: msg.ok ? "#15803d" : "#b3261e" }}>{msg.text}</span>}
      {confirming && (
        <div role="dialog" aria-modal="true" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "grid", placeItems: "center", zIndex: 80 }}
          onClick={(e) => { if (e.target === e.currentTarget) setConfirming(false); }}>
          <div style={{ background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 10, padding: "1.1rem 1.3rem", maxWidth: 460 }}>
            <h2 style={{ margin: "0 0 0.4rem" }}>Hard-match to the existing Entra account?</h2>
            <p className="note" style={{ marginTop: 0 }}>
              This writes the on-prem <code>mS-DS-ConsistencyGuid</code> to the flagged Entra object&rsquo;s
              <code> immutableId</code> so Azure AD Connect links them on the next sync — preventing a duplicate.
              It changes the account&rsquo;s sync anchor, so only do this if this is the same person.
            </p>
            <div className="toolbar" style={{ justifyContent: "flex-end", marginTop: "0.6rem" }}>
              <button onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
              <button className="primary" onClick={run} disabled={busy}>{busy ? "Queuing…" : "Link them"}</button>
            </div>
          </div>
        </div>
      )}
    </span>
  );
}
