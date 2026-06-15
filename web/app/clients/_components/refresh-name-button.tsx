"use client";

// Pull the client's name from ServiceNow (a renamed account, e.g. CORE2224). Narrow: updates only
// the name, never the other fields/edits.
import { useState } from "react";
import { useRouter } from "next/navigation";

export function RefreshNameButton({ slug }: { slug: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function run() {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`/api/clients/${slug}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "refresh-name" }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg({ ok: false, text: d.error ?? `failed (${r.status})` }); return; }
      setMsg({ ok: true, text: d.changed ? `Updated to “${d.name}” (was “${d.previous}”)` : `Already up to date (“${d.name}”)` });
      if (d.changed) router.refresh();
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    finally { setBusy(false); }
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <button onClick={run} disabled={busy} title="Pull the latest name from ServiceNow (for a renamed account) — updates only the name">
        {busy ? "Checking ServiceNow…" : "Name update"}
      </button>
      {msg && <span className="note" style={{ color: msg.ok ? "#15803d" : "#b91c1c" }}>{msg.text}</span>}
    </span>
  );
}
