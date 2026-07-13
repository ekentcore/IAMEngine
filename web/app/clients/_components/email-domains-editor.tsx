"use client";

// Curate the client's list of email domains offered as per-case choices. For M365 clients the
// authoritative list comes from the tenant (Graph /domains via the m365-admin app registration);
// manual add covers everyone else. The DEFAULT stays the curated emailDomain (locked) — picking a
// different default here calls the existing set-email-domain action.
import { useState } from "react";
import { useRouter } from "next/navigation";

type TenantDomain = { name: string; isDefault: boolean; isVerified: boolean };

export function EmailDomainsEditor({ slug, domains, defaultDomain }: { slug: string; domains: string[]; defaultDomain: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<string[]>(domains);
  const [tenant, setTenant] = useState<TenantDomain[] | null>(null);
  const [add, setAdd] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function pull() {
    setBusy("pull"); setMsg(null);
    try {
      const r = await fetch(`/api/clients/${slug}/domains/refresh`, { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg({ ok: false, text: d.error ?? `failed (${r.status})` }); return; }
      setTenant(d.domains ?? []);
      setMsg({ ok: true, text: `${(d.domains ?? []).length} verified domain(s) in the tenant — tick the ones to offer` });
    } finally { setBusy(null); }
  }

  async function save(next: string[]) {
    setBusy("save"); setMsg(null);
    try {
      const r = await fetch(`/api/clients/${slug}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set-domains", domains: next }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg({ ok: false, text: d.error ?? `failed (${r.status})` }); return; }
      setList(d.domains ?? next);
      router.refresh();
    } finally { setBusy(null); }
  }

  async function makeDefault(domain: string) {
    setBusy("default"); setMsg(null);
    try {
      const r = await fetch(`/api/clients/${slug}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set-email-domain", domain, lock: true }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); setMsg({ ok: false, text: d.error ?? `failed (${r.status})` }); return; }
      router.refresh();
    } finally { setBusy(null); }
  }

  const toggle = (name: string) => void save(list.includes(name) ? list.filter((d) => d !== name) : [...list, name]);

  if (!open) {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <span className="note">Email domains: {list.length ? list.join(", ") : "—"}{defaultDomain ? ` · default ${defaultDomain}` : ""}</span>
        <button onClick={() => setOpen(true)} style={{ fontSize: 12 }}>Edit</button>
      </span>
    );
  }

  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "0.6rem 0.75rem", marginTop: 6 }}>
      <div className="toolbar" style={{ marginBottom: 6 }}>
        <strong style={{ fontSize: 13 }}>Email domains offered on cases</strong>
        <button disabled={busy !== null} onClick={() => void pull()} title="List the tenant's verified domains via Graph (needs Domain.Read.All on the m365-admin app registration)">
          {busy === "pull" ? "Pulling…" : "⟳ Pull from Microsoft 365"}
        </button>
        <button onClick={() => setOpen(false)} style={{ marginLeft: "auto" }}>Close</button>
      </div>
      {(tenant ?? []).map((t) => (
        <label key={t.name} style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 0", fontSize: 13 }}>
          <input type="checkbox" style={{ width: "auto" }} checked={list.includes(t.name)} disabled={busy !== null} onChange={() => toggle(t.name)} />
          {t.name}
          {t.isDefault && <span className="note">(tenant default)</span>}
          {t.name === defaultDomain && <span className="note">· case default</span>}
          {t.name !== defaultDomain && list.includes(t.name) && (
            <button style={{ fontSize: 11 }} disabled={busy !== null} onClick={() => void makeDefault(t.name)}>make default</button>
          )}
        </label>
      ))}
      {tenant === null && list.map((d) => (
        <span key={d} style={{ display: "inline-flex", alignItems: "center", gap: 4, border: "1px solid var(--line)", borderRadius: 6, padding: "1px 8px", marginRight: 6, fontSize: 12.5 }}>
          {d}{d === defaultDomain && <span className="note">· default</span>}
          {d !== defaultDomain && <button style={{ fontSize: 11, padding: "0 4px" }} disabled={busy !== null} onClick={() => void makeDefault(d)}>★</button>}
          <button style={{ fontSize: 11, padding: "0 4px" }} disabled={busy !== null} title="Remove" onClick={() => toggle(d)}>✕</button>
        </span>
      ))}
      <div className="toolbar" style={{ marginTop: 6 }}>
        <input value={add} onChange={(e) => setAdd(e.target.value)} placeholder="add domain (acme.com)" style={{ width: 180, fontSize: 12.5 }}
          onKeyDown={(e) => { if (e.key === "Enter" && add.trim()) { e.preventDefault(); void save([...list, add.trim().toLowerCase()]); setAdd(""); } }} />
        <button disabled={busy !== null || !add.trim()} onClick={() => { void save([...list, add.trim().toLowerCase()]); setAdd(""); }}>Add</button>
        {msg && <span className="note" style={{ color: msg.ok ? "#15803d" : "#b91c1c" }}>{msg.text}</span>}
      </div>
    </div>
  );
}
