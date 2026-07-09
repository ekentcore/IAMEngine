"use client";

// Set which M365 license(s) new users get for this client. This edits the m365 system config
// (config.onboard.licenses) — the value the executor actually assigns — NOT the runbook doc. After
// saving, re-plan open cases to apply the change to in-flight ones.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { COMMON_LICENSES as COMMON } from "@/lib/m365/license-catalog";

export function M365LicenseEditor({ slug, current }: { slug: string; current: string[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<string[]>(current);
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const options = [...new Set([...COMMON, ...current])];
  const toggle = (name: string) => setSel((s) => (s.includes(name) ? s.filter((x) => x !== name) : [...s, name]));
  const addCustom = () => { const t = custom.trim(); if (t && !sel.includes(t)) { setSel([...sel, t]); } setCustom(""); };

  if (!open) {
    return (
      <div className="note" style={{ marginTop: "0.5rem" }}>
        Onboarding license{current.length === 1 ? "" : "s"}: <b>{current.length ? current.join(", ") : "(none set)"}</b>{" "}
        <button style={{ fontSize: 12, marginLeft: 6 }} onClick={() => { setSel(current); setMsg(null); setOpen(true); }}>Change license</button>
      </div>
    );
  }

  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "0.7rem 0.9rem", marginTop: "0.5rem", maxWidth: 460 }}>
      <b style={{ fontSize: 14 }}>M365 onboarding license</b>
      <p className="note" style={{ margin: "0.2rem 0 0.5rem" }}>What new users get assigned. This is the executed value (not the runbook doc).</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {options.map((name) => (
          <label key={name} style={{ display: "flex", alignItems: "center", gap: 6, margin: 0, fontSize: 13, color: "var(--fg)" }}>
            <input type="checkbox" style={{ width: "auto" }} checked={sel.includes(name)} onChange={() => toggle(name)} />
            {name}
          </label>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
        <input value={custom} placeholder="other license name or SKU part number" onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCustom(); } }} style={{ fontSize: 12 }} />
        <button style={{ fontSize: 12 }} onClick={addCustom} disabled={!custom.trim()}>Add</button>
      </div>
      {msg && <p className="note" style={{ color: msg.ok ? "#15803d" : "#b91c1c", marginTop: 6 }}>{msg.text}</p>}
      <div className="toolbar" style={{ marginTop: 8 }}>
        <button className="primary" disabled={busy} onClick={async () => {
          setBusy(true); setMsg(null);
          try {
            const r = await fetch(`/api/clients/${slug}/m365-licenses`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ licenses: sel }) });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) { setMsg({ ok: false, text: d.error ?? `failed (${r.status})` }); return; }
            setMsg({ ok: true, text: "✓ Saved. Re-plan this client's open cases to apply to in-flight onboardings." });
            router.refresh();
          } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
          finally { setBusy(false); }
        }}>{busy ? "Saving…" : "Save license"}</button>
        <button disabled={busy} onClick={() => setOpen(false)}>Close</button>
      </div>
    </div>
  );
}
