"use client";

// "Generate random password" on a case's AD / M365 / Google Workspace line (INC0855142): dispatches
// an ad-hoc reset job that sets a fresh app-generated password on the account, then reveals it
// EXACTLY ONCE in a popup with a copy button. The value is wiped server-side on reveal (and on
// failure) — it cannot be recalled. If the popup is closed before the reveal, the reset line itself
// offers a one-shot "reveal password" until it's shown.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CopyButton } from "@/app/_components/copy-button";
import { MANUAL_PASSWORD_HINT, validateManualPassword } from "@/lib/auth/password-policy";

type RevealResponse = { ready?: boolean; status?: string; password?: string; error?: string };

const overlayStyle: React.CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "grid", placeItems: "center", zIndex: 80 };
const cardStyle: React.CSSProperties = { background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 10, padding: "1.1rem 1.3rem", maxWidth: 460, boxShadow: "var(--shadow-2, 0 10px 40px rgba(0,0,0,.3))" };

// Portal the overlay to <body>: rendered inline (inside the step's <details> row) the fixed overlay
// can end up positioned by a transformed/contained ancestor — the dialog then appears far down the
// page instead of centered in the viewport. These dialogs only mount after a click, so document exists.
function Overlay({ onBackdropClick, children }: { onBackdropClick?: () => void; children: React.ReactNode }) {
  return createPortal(
    <div role="dialog" aria-modal="true" style={overlayStyle} onClick={(e) => { if (e.target === e.currentTarget) onBackdropClick?.(); }}>
      <div style={cardStyle}>{children}</div>
    </div>,
    document.body
  );
}

// The one-time reveal popup: polls the reveal endpoint while the reset job runs, then shows the
// password once with Copy. Shared by the generate flow and the reset line's re-reveal.
function RevealDialog({ resetJobId, systemName, onClose, requireChange }: { resetJobId: string; systemName: string; onClose: () => void; requireChange?: boolean }) {
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
    <Overlay onBackdropClick={() => { if (state.pw || state.error) onClose(); }}>
      <h2 style={{ margin: "0 0 0.25rem" }}>New password — {systemName}</h2>
      {state.pw ? (
        <>
          <p className="note" style={{ color: "#b3261e", marginTop: 0 }}>
            {/* Only assert the change-at-sign-in behavior when this dialog KNOWS it: the re-reveal
                path (RevealResetPasswordButton) doesn't carry the generate-time choice, and telling
                the operator "the user must change it" about a password that keeps working would be
                a false safety claim. */}
            ⚠ Shown once. Save it now — it can&rsquo;t be shown again.
            {requireChange === false ? " Change at next sign-in was NOT required — reset again once equipment setup is done if it was exposed." : ""}
            {requireChange === true ? " The user must change it at next sign-in." : ""}
          </p>
          <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "0.6rem 0" }}>
            <code style={{ fontSize: 16, padding: "0.35rem 0.6rem", border: "1px solid var(--line)", borderRadius: 6, userSelect: "all" }}>{state.pw}</code>
            {/* Shown once and gone on "I saved it" — a copy that quietly did nothing (which is what
                the old `navigator.clipboard?.` call did on the LAN URL) loses the password outright. */}
            <CopyButton text={state.pw} label="Copy" copiedLabel="Copied ✓" style={{ fontSize: 13, padding: "0.3rem 0.7rem" }} />
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
    </Overlay>
  );
}

// The per-line entry point on AD / M365 / Entra / Google Workspace steps (the run report only
// renders it for systemKeys in PASSWORD_RESET_KEY).
export function GeneratePasswordButton({ jobId, systemName, refresh }: { jobId: string; systemName: string; refresh?: () => Promise<void> | void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resetJobId, setResetJobId] = useState<string | null>(null);
  const [manualSet, setManualSet] = useState(false); // FR #17: a specific password was set (no reveal)
  const [err, setErr] = useState<string | null>(null);
  // FR #14: default ON; untick when a tech still has to log in AS the user (equipment setup)
  // before handing the account over — a forced change at first sign-in would land on the tech.
  const [requireChange, setRequireChange] = useState(true);
  // FR #17: "generate" a random password (shown once) or set a "manual" specific one (e.g. a required
  // passphrase). A manual password the operator chose on purpose would be wiped by a forced change at
  // next sign-in, so switching to manual clears that box; they can re-tick it.
  const [mode, setMode] = useState<"generate" | "manual">("generate");
  const [customPw, setCustomPw] = useState("");

  const pwError = mode === "manual" ? validateManualPassword(customPw) : null;
  const canSubmit = !busy && (mode === "generate" || (customPw.length > 0 && !pwError));

  // Clear the dialog. On open/Cancel we reset everything; after dispatch we keep `requireChange` so
  // RevealDialog reads the value that was actually sent (not a reset-to-default).
  function reset(opts?: { keepRequireChange?: boolean }) {
    setConfirming(false); setMode("generate"); setCustomPw(""); setErr(null);
    if (!opts?.keepRequireChange) setRequireChange(true);
  }

  async function dispatch() {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/jobs/${jobId}/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requireChangeAtSignIn: requireChange,
          ...(mode === "manual" ? { password: customPw } : {}),
        }),
      });
      const d = (await r.json().catch(() => ({}))) as { jobId?: string; manual?: boolean; error?: string };
      if (!r.ok || !d.jobId) { setErr(d.error ?? `failed (${r.status})`); return; }
      const wasManual = mode === "manual";
      reset({ keepRequireChange: true });
      // Generated → reveal it once. Manual → the operator already knows it; just confirm it was queued.
      if (wasManual) setManualSet(true); else setResetJobId(d.jobId);
      await refresh?.();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <>
      <button
        style={{ marginLeft: 8, fontSize: 11 }}
        title="Set a new password on this account — either generated (shown once) or a specific password you enter."
        onClick={(e) => { e.preventDefault(); reset(); setConfirming(true); }}
      >
        🔑 set / generate password
      </button>
      {err && !confirming && <span className="note" style={{ marginLeft: 6, color: "#b3261e" }}>{err}</span>}
      {confirming && (
        <Overlay onBackdropClick={() => reset()}>
          <h2 style={{ margin: "0 0 0.25rem" }}>Set a new password — {systemName}</h2>
          <p className="note" style={{ marginTop: 0 }}>
            This sets a new password on the account in {systemName} right now — the current password stops working.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, margin: "0.6rem 0" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, margin: 0, fontSize: 13 }}>
              <input type="radio" name={`pwmode-${jobId}`} checked={mode === "generate"} onChange={() => { setMode("generate"); setRequireChange(true); }} style={{ width: "auto" }} />
              Generate a random password (shown once, then wiped)
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6, margin: 0, fontSize: 13 }}>
              <input type="radio" name={`pwmode-${jobId}`} checked={mode === "manual"} onChange={() => { setMode("manual"); setRequireChange(false); }} style={{ width: "auto" }} />
              Enter a specific password
            </label>
          </div>
          {mode === "generate" ? (
            <p className="note" style={{ marginTop: 0 }}>
              The new password is shown <b>once</b>, then wiped for security; it cannot be recalled.
            </p>
          ) : (
            <div style={{ margin: "0 0 0.4rem" }}>
              {/* Plain text (not masked): the operator is choosing a password to hand over, so seeing
                  exactly what they typed prevents a typo becoming an un-recallable account password. */}
              <input
                type="text" value={customPw} onChange={(e) => setCustomPw(e.target.value)} autoComplete="off" spellCheck={false}
                placeholder="the password to set" style={{ width: "100%", fontSize: 14, fontFamily: "var(--mono, monospace)" }}
              />
              <p className="note" style={{ margin: "3px 0 0", minHeight: "2.5em", color: customPw.length > 0 && pwError ? "#b3261e" : undefined }}>
                {customPw.length > 0 && pwError ? pwError : MANUAL_PASSWORD_HINT}
              </p>
            </div>
          )}
          <label className="note" style={{ display: "flex", alignItems: "center", gap: 6, margin: "0.4rem 0" }}>
            <input type="checkbox" checked={requireChange} onChange={(e) => setRequireChange(e.target.checked)} style={{ width: "auto" }} />
            Require the user to change this password at next sign-in
          </label>
          {!requireChange && (
            <p className="note" style={{ marginTop: 0 }}>
              {mode === "manual"
                ? "The password stays as you entered it. Hand it over securely, and reset again if it was exposed."
                : "The password stays as generated — for setting up equipment logged in as the user. Hand it over securely, and reset again if it was exposed."}
            </p>
          )}
          {err && <p className="note" style={{ color: "#b3261e" }}>{err}</p>}
          <div className="toolbar" style={{ justifyContent: "flex-end", gap: 8 }}>
            <button onClick={() => reset()}>Cancel</button>
            <button className="primary" disabled={!canSubmit} onClick={dispatch}>{busy ? "Dispatching…" : "Set new password"}</button>
          </div>
        </Overlay>
      )}
      {manualSet && (
        <Overlay onBackdropClick={() => setManualSet(false)}>
          <h2 style={{ margin: "0 0 0.25rem" }}>Password queued — {systemName}</h2>
          <p className="note" style={{ marginTop: 0 }}>
            The password you entered will be set on the next runner poll. Watch the reset line below for the result — there&rsquo;s no reveal because you already have it.
          </p>
          <div className="toolbar" style={{ justifyContent: "flex-end" }}>
            <button className="primary" onClick={() => setManualSet(false)}>OK</button>
          </div>
        </Overlay>
      )}
      {resetJobId && <RevealDialog resetJobId={resetJobId} systemName={systemName} requireChange={requireChange} onClose={() => setResetJobId(null)} />}
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
