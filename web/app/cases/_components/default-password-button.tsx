"use client";

// "Show default password" (FR #86): the client's standing default initial password, so the operator can
// send it to the client. Not one-time — unlike the generate-mode reveal nothing is wiped — but every
// view is audited server-side. A Delinea-backed default shows the secret reference instead of a value.
import { useState } from "react";
import { createPortal } from "react-dom";
import { CopyButton } from "@/app/_components/copy-button";

type Shown = { mode: "fixed"; password: string } | { mode: "secret"; secretName: string; delineaId: string | null };

export function DefaultPasswordButton({ caseId }: { caseId: string }) {
  const [shown, setShown] = useState<Shown | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function show() {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/cases/${caseId}/default-password`, { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(d.error ?? `failed (${r.status})`); return; }
      setShown(d as Shown);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
      <button onClick={show} disabled={busy} title="Show this client's default initial password for new users, to send to the client">
        {busy ? "Loading…" : "🔑 Show default password"}
      </button>
      {err && <span className="note" style={{ color: "#b3261e" }}>{err}</span>}
      {shown && createPortal(
        // Portaled for the same reason as the other password dialogs: a fixed overlay inside a
        // transformed ancestor lands far down the page instead of centered.
        <div role="dialog" aria-modal="true" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "grid", placeItems: "center", zIndex: 80 }}
          onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) setShown(null); }}>
          <div style={{ background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 10, padding: "1.1rem 1.3rem", maxWidth: 440, boxShadow: "var(--shadow-2, 0 10px 40px rgba(0,0,0,.3))" }}>
            <h2 style={{ margin: "0 0 0.25rem" }}>Default password</h2>
            {shown.mode === "fixed" ? (
              <>
                <p className="note" style={{ marginTop: 0 }}>This client&rsquo;s default initial password for new users. Send it securely.</p>
                <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "0.6rem 0" }}>
                  <code style={{ fontSize: 16, padding: "0.35rem 0.6rem", border: "1px solid var(--line)", borderRadius: 6, userSelect: "all" }}>{shown.password}</code>
                  <CopyButton text={shown.password} label="Copy" copiedLabel="Copied ✓" style={{ fontSize: 13, padding: "0.3rem 0.7rem" }} />
                </div>
              </>
            ) : (
              <p className="note" style={{ marginTop: 0 }}>
                This client&rsquo;s default password is kept in Delinea{shown.delineaId ? <> — secret <b>#{shown.delineaId}</b></> : " (not wired yet)"}. The app holds only the reference, so open it in Secret Server to send it.
              </p>
            )}
            <div className="toolbar" style={{ justifyContent: "flex-end" }}>
              <button className="primary" onClick={() => setShown(null)}>Close</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </span>
  );
}
