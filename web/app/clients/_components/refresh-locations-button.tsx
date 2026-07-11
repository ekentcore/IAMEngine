"use client";

// Pull the client's offices from ServiceNow's cmn_location table into the Locations table — the
// authoritative source (all sites, real street addresses, correct time zones), replacing the fleet
// generator's guesses. Non-destructive when nothing matches (keeps the existing set).
import { useState } from "react";
import { useRouter } from "next/navigation";

export function RefreshLocationsButton({ slug }: { slug: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function run() {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`/api/clients/${slug}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "refresh-locations" }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg({ ok: false, text: d.error ?? `failed (${r.status})` }); return; }
      setMsg({ ok: true, text: d.note ?? `Synced ${d.count} location${d.count === 1 ? "" : "s"} from ServiceNow` });
      if (d.count > 0) router.refresh();
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    finally { setBusy(false); }
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <button onClick={run} disabled={busy} title="Pull this client's offices from ServiceNow (cmn_location) — replaces the generated locations with the real names, addresses, and time zones">
        {busy ? "Syncing ServiceNow…" : "⟳ Refresh locations"}
      </button>
      {msg && <span className="note" style={{ color: msg.ok ? "#15803d" : "#b91c1c" }}>{msg.text}</span>}
    </span>
  );
}
