"use client";

// How a new user's initial M365 password is set: generated (default), a fixed default (from the KB),
// or brokered from a Delinea Secret Server reference (resolved at dispatch like any credential).
import { useState } from "react";
import { useRouter } from "next/navigation";

type Mode = "generate" | "fixed" | "secret";

export function M365PasswordEditor({ slug, current }: { slug: string; current: { mode: Mode; delineaId?: string } }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>(current.mode);
  const [value, setValue] = useState("");
  const [delineaId, setDelineaId] = useState(current.delineaId ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const label = current.mode === "fixed" ? "fixed default" : current.mode === "secret"
    ? `Delinea secret${current.delineaId ? ` #${current.delineaId}` : ""}`
    : "generated";

  if (!open) {
    return (
      <div className="note" style={{ marginTop: "0.4rem" }}>
        Initial password: <b>{label}</b>{" "}
        <button style={{ fontSize: 12, marginLeft: 6 }} onClick={() => { setMode(current.mode); setDelineaId(current.delineaId ?? ""); setMsg(null); setOpen(true); }}>Change</button>
      </div>
    );
  }

  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "0.7rem 0.9rem", marginTop: "0.4rem", maxWidth: 520 }}>
      <b style={{ fontSize: 14 }}>New-user initial password</b>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, margin: "0.5rem 0" }}>
        {(["generate", "fixed", "secret"] as Mode[]).map((m) => (
          <label key={m} style={{ display: "flex", alignItems: "center", gap: 6, margin: 0, fontSize: 13, color: "var(--fg)" }}>
            <input type="radio" name="pwmode" checked={mode === m} onChange={() => setMode(m)} style={{ width: "auto" }} />
            {m === "generate" ? "Generate a random compliant password (default)" : m === "fixed" ? "Use a fixed default password (from the KB)" : "Default Password from Delinea (enter the secret id)"}
          </label>
        ))}
      </div>
      {mode === "fixed" && (
        <input type="text" value={value} onChange={(e) => setValue(e.target.value)} placeholder="default password (≥ 8 chars)" style={{ maxWidth: 320, fontSize: 13 }} />
      )}
      {mode === "secret" && (
        <div>
          <input value={delineaId} onChange={(e) => setDelineaId(e.target.value)} placeholder="Delinea secret id / number (e.g. 6835)" style={{ maxWidth: 320, fontSize: 13 }} />
          <p className="note" style={{ margin: "3px 0 0" }}>The Delinea secret reference for the default password (from the KB link). Brokered at run time — the value is never stored here.</p>
        </div>
      )}
      {mode === "fixed" && <p className="note danger" style={{ margin: "4px 0 0" }}>A fixed password is stored in this client&rsquo;s config. Prefer the Delinea option for anything sensitive.</p>}
      {msg && <p className="note" style={{ color: msg.ok ? "#15803d" : "#b91c1c", marginTop: 6 }}>{msg.text}</p>}
      <div className="toolbar" style={{ marginTop: 8 }}>
        <button className="primary" disabled={busy} onClick={async () => {
          setBusy(true); setMsg(null);
          try {
            const r = await fetch(`/api/clients/${slug}/m365-password`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode, value, delineaId }) });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) { setMsg({ ok: false, text: d.error ?? `failed (${r.status})` }); return; }
            setMsg({ ok: true, text: "✓ Saved. Re-plan open cases to apply." });
            router.refresh();
          } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
          finally { setBusy(false); }
        }}>{busy ? "Saving…" : "Save"}</button>
        <button disabled={busy} onClick={() => setOpen(false)}>Close</button>
      </div>
    </div>
  );
}
