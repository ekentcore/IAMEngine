"use client";

// Super-admin "Impersonate" control in the header: a small button that opens a typeahead over users;
// picking one starts a view-as session (their RBAC). Reloads so the whole app re-renders as them.
import { useRef, useState } from "react";

type U = { id: string; name: string | null; email: string; role: string };

export function ImpersonatePicker() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<U[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function search(v: string) {
    setQ(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/users/search?q=${encodeURIComponent(v)}`);
        if (res.ok) setResults((await res.json()) as U[]);
      } catch {
        /* ignore transient search errors */
      }
    }, 180);
  }

  function toggle() {
    const n = !open;
    setOpen(n);
    if (n) { setErr(""); search(q); }
  }

  async function pick(u: U) {
    setBusy(true);
    setErr("");
    try {
      const res = await fetch("/api/impersonate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: u.id }) });
      if (!res.ok) { setErr((await res.json().catch(() => ({}))).error ?? "Could not impersonate."); setBusy(false); return; }
      window.location.href = "/clients"; // reload as the impersonated user
    } catch {
      setErr("Request failed.");
      setBusy(false);
    }
  }

  return (
    <div style={{ position: "relative" }}>
      <button type="button" className="nav-link" onClick={toggle} title="View the app as another user (super admin)" style={{ fontSize: 12 }}>
        Impersonate
      </button>
      {open && (
        <div style={{ position: "absolute", right: 0, top: "100%", marginTop: 6, width: 300, background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 10, boxShadow: "var(--shadow-1)", padding: 10, zIndex: 50 }}>
          <input autoFocus type="text" placeholder="Search a user by name or email…" value={q} onChange={(e) => search(e.target.value)} />
          <div style={{ marginTop: 8, maxHeight: 280, overflowY: "auto" }}>
            {results.length === 0 ? (
              <div className="note" style={{ padding: "0.4rem" }}>No matching users.</div>
            ) : (
              results.map((u) => (
                <button key={u.id} type="button" disabled={busy} onClick={() => pick(u)}
                  style={{ display: "block", width: "100%", textAlign: "left", padding: "0.4rem 0.5rem", background: "transparent", border: "none", borderRadius: 6, cursor: "pointer" }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--accent-soft)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{u.name || u.email}</div>
                  <div className="note" style={{ fontSize: 11 }}>{u.email} · {u.role}</div>
                </button>
              ))
            )}
          </div>
          {err && <div className="note danger" style={{ marginTop: 6 }}>{err}</div>}
        </div>
      )}
    </div>
  );
}
