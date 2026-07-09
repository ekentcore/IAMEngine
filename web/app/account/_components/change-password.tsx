"use client";

import { useState } from "react";

export function ChangePassword() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (next !== confirm) { setMsg({ ok: false, text: "the new passwords don't match" }); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/auth/change-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword: current, newPassword: next }) });
      if (!r.ok) { setMsg({ ok: false, text: ((await r.json().catch(() => ({}))) as { error?: string }).error ?? "failed" }); return; }
      setMsg({ ok: true, text: "✓ Password changed. Other sessions were signed out." });
      setCurrent(""); setNext(""); setConfirm("");
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ marginTop: "1.5rem", maxWidth: 360 }}>
      <h2>Change password</h2>
      <label htmlFor="cp-cur">Current password</label>
      <input id="cp-cur" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      <label htmlFor="cp-new">New password</label>
      <input id="cp-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={10} />
      <label htmlFor="cp-conf">Confirm new password</label>
      <input id="cp-conf" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
      {msg && <p className="note" style={{ color: msg.ok ? "#15803d" : "#b91c1c", marginTop: "0.6rem" }}>{msg.text}</p>}
      <button className="primary" type="submit" disabled={busy} style={{ marginTop: "0.9rem" }}>{busy ? "Saving…" : "Change password"}</button>
    </form>
  );
}
