"use client";

// Re-wire the systems list from the SAVED runbook: any modeled system a runbook section maps to
// that the client doesn't have yet gets a ClientSystem row with catalog defaults. Non-destructive —
// existing systems keep their lanes/config/secrets. For runbooks saved before the save-time sync
// existed, or after a KB refresh added a section.
import { useState } from "react";
import { useRouter } from "next/navigation";

export function SyncSystemsButton({ slug }: { slug: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function run() {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`/api/clients/${slug}/systems/sync-from-runbook`, { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg({ ok: false, text: d.error ?? `failed (${r.status})` }); return; }
      const created: string[] = d.createdSystems ?? [];
      setMsg({ ok: true, text: created.length ? `Added ${created.join(", ")}` : "Systems already match the runbook" });
      if (created.length) router.refresh();
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    finally { setBusy(false); }
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <button onClick={run} disabled={busy} title="Add any modeled system the saved runbook references but the client lacks (catalog defaults; existing systems are untouched)">
        {busy ? "Syncing…" : "⟳ Sync systems from runbook"}
      </button>
      {msg && <span className="note" style={{ color: msg.ok ? "#15803d" : "#b91c1c" }}>{msg.text}</span>}
    </span>
  );
}
