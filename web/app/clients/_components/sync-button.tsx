"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function SyncButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function refresh() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/clients/sync", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setMsg(`Sync failed: ${data.error ?? res.statusText}`);
      } else {
        setMsg(
          `Synced ${data.total}: ${data.created} new, ${data.reconciled} linked, ${data.updated} updated` +
            (data.errors?.length ? `, ${data.errors.length} errors` : "")
        );
        router.refresh();
      }
    } catch (err) {
      setMsg(`Sync failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="primary" onClick={refresh} disabled={busy}>
        {busy ? "Refreshing…" : "Refresh from ServiceNow"}
      </button>
      {msg && <span className="note">{msg}</span>}
    </>
  );
}
