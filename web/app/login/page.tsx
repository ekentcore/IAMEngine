"use client";

// Sign-in screen. Local email/password now; an "O365" button is reserved for the SSO follow-on.
// Posts to /api/auth/login, then hard-navigates so the server re-renders with the session.
import { useState } from "react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
      if (!r.ok) {
        setError(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "sign-in failed");
        return;
      }
      const next = new URLSearchParams(window.location.search).get("next");
      window.location.href = next && next.startsWith("/") ? next : "/clients";
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 380, marginTop: "8vh" }}>
      <h1 style={{ marginBottom: "0.25rem" }}>Sign in</h1>
      <p className="note" style={{ marginTop: 0 }}>iam-engine — IAM lifecycle automation</p>
      <form onSubmit={submit} style={{ marginTop: "1.25rem" }}>
        <label htmlFor="email">Email</label>
        <input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
        <label htmlFor="password">Password</label>
        <input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error && <p className="note danger" style={{ marginTop: "0.7rem" }}>{error}</p>}
        <button className="primary" type="submit" disabled={busy} style={{ width: "100%", marginTop: "1rem", justifyContent: "center" }}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <p className="note" style={{ marginTop: "1.25rem", color: "var(--faint)" }}>
        Microsoft 365 single sign-on is coming soon. Local accounts are for admin control and break-glass access.
      </p>
    </main>
  );
}
