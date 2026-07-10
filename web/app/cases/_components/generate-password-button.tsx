"use client";

// "Generate random password" on a case's AD / M365 / Google Workspace line (INC0855142): dispatches
// an ad-hoc reset job that sets a fresh app-generated password on the account, then reveals it
// EXACTLY ONCE in a popup with a copy button. The value is wiped server-side on reveal (and on
// failure) — it cannot be recalled. If the popup is closed before the reveal, the reset line itself
// offers a one-shot "reveal password" until it's shown.
import { useEffect, useRef, useState } from "react";

type RevealResponse = { ready?: boolean; status?: string; password?: string; error?: string };

const overlayStyle: React.CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "grid", placeItems: "center", zIndex: 80 };
const cardStyle: React.CSSProperties = { background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 10, padding: "1.1rem 1.3rem", maxWidth: 460, boxShadow: "var(--shadow-2, 0 10px 40px rgba(0,0,0,.3))" };

// The one-time reveal popup: polls the reveal endpoint while the reset job runs, then shows the
// password once with Copy. Shared by the generate flow and the reset line's re-reveal.
function RevealDialog({ resetJobId, systemName, onClose }: { resetJobId: string; systemName: string; onClose: () => void }) {
  const [state, setState] = useState<{ pw?: string; status?: string; error?: string }>({ status: "pending" });
  const done = useRef(false);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      if (cancelled || done.current) return;
      try {
        const r = await fetch(`/api/jobs/${resetJobId}/reveal-reset-password`, { method: "POST" });
        const d = (await r.json().catch(() => ({}))) as RevealResponse;
        if (cancelled) return;
        if (r.ok && d.ready && d.password) { done.current = true; setState({ pw: d.password }); return; }
        if (!r.ok) { done.current = true; setState({ error: d.error ?? `failed (${r.status})` }); return; }
        if (d.status && !["pending", "dispatched", "running"].includes(d.status)) {
          done.current = true; setState({ error: d.error ?? `the reset ${d.status} — the password was NOT changed`, status: d.status }); return;
        }
        setState({ status: d.status ?? "pending" });
      } catch { /* transient network blip — keep waiting; the next poll retries */ }
      if (!cancelled && !done.current) setTimeout(poll, 2500);
    }
    void poll();
    return () => { cancelled = true; };
  }, [resetJobId]);

  return (
    <div role="dialog" aria-modal="true" style={overlayStyle} onClick={(e) => { if (e.target === e.currentTarget && (state.pw || state.error)) onClose(); }}>
      <div style={cardStyle}>
        <h2 style={{ margin: "0 0 0.25rem" }}>New password — {systemName}</h2>
        {state.pw ? (
          <>
            <p className="note" style={{ color: "#b3261e", marginTop: 0 }}>⚠ Shown once. Save it now — it can&rsquo;t be shown again. The user must change it at next sign-in.</p>
            <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "0.6rem 0" }}>
              <code style={{ fontSize: 16, padding: "0.35rem 0.6rem", border: "1px solid var(--line)", borderRadius: 6, userSelect: "all" }}>{state.pw}</code>
              <button onClick={() => navigator.clipboard?.writeText(state.pw!)}>Copy</button>
            </div>
            <div className="toolbar" style={{ justifyContent: "flex-end" }}>
              <button className="primary" onClick={onClose}>I saved it</button>
            </div>
          </>
        ) : state.error ? (
          <>
            <p className="note" style={{ color: "#b3261e" }}>{state.error}</p>
            <div className="toolbar" style={{ justifyContent: "flex-end" }}>
              <button onClick={onClose}>Close</button>
            </div>
          </>
        ) : (
          <>
            <p className="note" style={{ marginTop: 0 }}>Setting the password… waiting for the runner to pick up and finish the reset ({state.status ?? "pending"}).</p>
            <p className="note">You can close this — once the reset lands, the new step line below offers the one-time reveal.</p>
            <div className="toolbar" style={{ justifyContent: "flex-end" }}>
              <button onClick={onClose}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// The per-line entry point on AD / M365 / Entra / Google Workspace steps (the run report only
// renders it for systemKeys in PASSWORD_RESET_KEY).
export function GeneratePasswordButton({ jobId, systemName, refresh }: { jobId: string; systemName: string; refresh?: () => Promise<void> | void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resetJobId, setResetJobId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function dispatch() {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/jobs/${jobId}/reset-password`, { method: "POST" });
      const d = (await r.json().catch(() => ({}))) as { jobId?: string; error?: string };
      if (!r.ok || !d.jobId) { setErr(d.error ?? `failed (${r.status})`); return; }
      setConfirming(false);
      setResetJobId(d.jobId);
      await refresh?.();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <>
      <button
        style={{ marginLeft: 8, fontSize: 11 }}
        title="Set a completely random new password on this account and show it once (with copy). It can't be recalled afterwards."
        onClick={(e) => { e.preventDefault(); setConfirming(true); }}
      >
        🔑 generate random password
      </button>
      {err && !confirming && <span className="note" style={{ marginLeft: 6, color: "#b3261e" }}>{err}</span>}
      {confirming && (
        <div role="dialog" aria-modal="true" style={overlayStyle} onClick={(e) => { if (e.target === e.currentTarget) setConfirming(false); }}>
          <div style={cardStyle}>
            <h2 style={{ margin: "0 0 0.25rem" }}>Generate random password — {systemName}</h2>
            <p className="note" style={{ marginTop: 0 }}>
              This sets a <b>new random password</b> on the account in {systemName} right now — the current password stops working,
              and the user must change it at next sign-in. The new password is shown <b>once</b>, then wiped for security; it cannot be recalled.
            </p>
            {err && <p className="note" style={{ color: "#b3261e" }}>{err}</p>}
            <div className="toolbar" style={{ justifyContent: "flex-end", gap: 8 }}>
              <button onClick={() => setConfirming(false)}>Cancel</button>
              <button className="primary" disabled={busy} onClick={dispatch}>{busy ? "Dispatching…" : "Set new password"}</button>
            </div>
          </div>
        </div>
      )}
      {resetJobId && <RevealDialog resetJobId={resetJobId} systemName={systemName} onClose={() => setResetJobId(null)} />}
    </>
  );
}

// On the reset step line itself: the one-time reveal for a popup that was closed before showing the
// value. Server-side 410 once it's been shown anywhere.
export function RevealResetPasswordButton({ jobId, systemName }: { jobId: string; systemName: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        style={{ marginLeft: 8, fontSize: 11 }}
        title="Show the generated password if it hasn't been revealed yet — it's shown exactly once, then wiped."
        onClick={(e) => { e.preventDefault(); setOpen(true); }}
      >
        🔑 reveal password (once)
      </button>
      {open && <RevealDialog resetJobId={jobId} systemName={systemName} onClose={() => setOpen(false)} />}
    </>
  );
}
