"use client";

// FR #88 — "Correct user…" and "Remove user…" on an onboard case, for the account this engine created.
// Correct fixes names and the username/email everywhere the onboard ran (old addresses stay as aliases).
// Remove hard-deletes it (the hire fell through): it queues one step per system, and each needs approval
// on the case before anything is deleted. Both go through the audited, case.dispatch-gated routes.
import { useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";

export type UserIdentity = { firstName: string; lastName: string; displayName: string; email: string };

function Dialog({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return createPortal(
    <div role="dialog" aria-modal="true" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "grid", placeItems: "center", zIndex: 80 }}
      onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 10, padding: "1.1rem 1.3rem", width: "min(460px, calc(100vw - 2rem))", boxShadow: "var(--shadow-2, 0 10px 40px rgba(0,0,0,.3))" }}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function CorrectUserButton({ caseId, current }: { caseId: string; current: UserIdentity }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState<UserIdentity>(current);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const changed = (Object.keys(v) as (keyof UserIdentity)[]).filter((k) => v[k].trim() && v[k].trim() !== current[k]);

  async function submit() {
    setBusy(true); setErr(null);
    try {
      const body = Object.fromEntries(changed.map((k) => [k, v[k].trim()]));
      const r = await fetch(`/api/cases/${caseId}/correct-user`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(d.error ?? `failed (${r.status})`); return; }
      setOpen(false); router.refresh();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  const field = (k: keyof UserIdentity, label: string) => (
    <label className="note" style={{ display: "flex", flexDirection: "column", gap: 3, margin: "0 0 0.5rem" }}>
      {label}
      <input value={v[k]} onChange={(e) => setV((s) => ({ ...s, [k]: e.target.value }))} disabled={busy} />
    </label>
  );

  return (
    <>
      <button onClick={() => { setV(current); setErr(null); setOpen(true); }} title="Fix a misspelled name or change the username/email on the account this onboard created">✏️ Correct user…</button>
      {open && (
        <Dialog onClose={() => setOpen(false)}>
          <h2 style={{ margin: "0 0 0.25rem" }}>Correct the user</h2>
          <p className="note" style={{ marginTop: 0 }}>Changes are made on every system this onboard set up. A new email becomes the primary address and sign-in name; the old one is kept as an alias so mail still arrives. The case shows the new details once every system has taken the change.</p>
          {field("firstName", "First name")}
          {field("lastName", "Last name")}
          {field("displayName", "Display name")}
          {field("email", "Email / username")}
          {err && <p className="note" style={{ color: "#b3261e" }}>{err}</p>}
          <div className="toolbar" style={{ justifyContent: "flex-end", gap: 8 }}>
            <button onClick={() => setOpen(false)}>Cancel</button>
            <button className="primary" disabled={busy || changed.length === 0} onClick={submit}>{busy ? "Queuing…" : "Correct user"}</button>
          </div>
        </Dialog>
      )}
    </>
  );
}

// `email` is the confirm key — the account the onboard created (removeConfirmKey); `accounts` lists
// every account the steps will delete, one per system. `preexisting` lists accounts that existed before
// this case (a rehire / adopted account): the server refuses a Remove then, so the dialog says so up front.
export function RemoveUserButton({ caseId, email, accounts, preexisting = [] }: { caseId: string; email: string; accounts: string[]; preexisting?: string[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/cases/${caseId}/remove-user`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(d.error ?? `failed (${r.status})`); return; }
      setOpen(false); router.refresh();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <>
      <button className="danger" onClick={() => { setConfirm(""); setErr(null); setOpen(true); }} title="Delete the account this onboard created (the hire fell through)">🗑 Remove user…</button>
      {open && (
        <Dialog onClose={() => setOpen(false)}>
          <h2 style={{ margin: "0 0 0.25rem" }}>Remove the user</h2>
          {preexisting.length > 0 ? (
            <>
              <p className="note" style={{ marginTop: 0 }}>
                &ldquo;Remove user&rdquo; only deletes accounts this case created. These existed before it (a rehire or an adopted account), so offboard the user instead:
              </p>
              <ul className="note" style={{ margin: "0 0 0.5rem" }}>{preexisting.map((a) => <li key={a}>{a}</li>)}</ul>
              <div className="toolbar" style={{ justifyContent: "flex-end" }}><button onClick={() => setOpen(false)}>Close</button></div>
            </>
          ) : (<>
          <p className="note" style={{ color: "#b3261e", marginTop: 0 }}>
            This permanently deletes the account this onboard created on each system. It adds one step per system to this case; each needs approval before it runs, and the user&rsquo;s groups are saved first.
          </p>
          <ul className="note" style={{ margin: "0 0 0.5rem" }}>
            {accounts.map((a) => <li key={a}>{a}</li>)}
          </ul>
          <p className="note">Google keeps a deleted user restorable for 20 days; AD and Microsoft 365 deletes are permanent.</p>
          <label className="note" style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            Type <b>{email}</b> to confirm
            <input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={email} disabled={busy} autoComplete="off" />
          </label>
          {err && <p className="note" style={{ color: "#b3261e" }}>{err}</p>}
          <div className="toolbar" style={{ justifyContent: "flex-end", gap: 8 }}>
            <button onClick={() => setOpen(false)}>Cancel</button>
            <button className="danger" disabled={busy || confirm.trim().toLowerCase() !== email.toLowerCase()} onClick={submit}>{busy ? "Queuing…" : "Queue removal"}</button>
          </div>
          </>)}
        </Dialog>
      )}
    </>
  );
}
