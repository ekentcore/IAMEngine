"use client";

// "↻ Force Spanning sync" on a case's Spanning step (verified/warning): dispatch an ad-hoc
// browser-automation job that drives the Spanning admin portal to trigger a directory scan, so a
// just-created M365 user is discovered NOW rather than on Spanning's own schedule. No reveal, no
// confirm modal — a simple POST with a transient inline status. Only agents that report the "browser"
// capability can claim the job; until one does, the new step line sits pending with a clear reason.
import { useState } from "react";

export function ForceSpanningSyncButton({ jobId, refresh }: { jobId: string; refresh?: () => Promise<void> | void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  async function dispatch() {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`/api/jobs/${jobId}/force-spanning-sync`, { method: "POST" });
      const d = (await r.json().catch(() => ({}))) as { jobId?: string; reused?: boolean; error?: string };
      if (!r.ok || !d.jobId) { setMsg({ text: d.error ?? `failed (${r.status})`, ok: false }); return; }
      setMsg({ text: d.reused ? "sync already in progress" : "sync dispatched — a browser agent will run it", ok: true });
      await refresh?.();
    } catch (e) {
      setMsg({ text: (e as Error).message, ok: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        style={{ marginLeft: 8, fontSize: 11 }}
        disabled={busy}
        title="Trigger a Spanning directory scan now (via browser automation) so Spanning discovers a just-created user instead of waiting for its own schedule. Runs on a browser-capable agent."
        onClick={(e) => { e.preventDefault(); dispatch(); }}
      >
        {busy ? "dispatching…" : "↻ force Spanning sync"}
      </button>
      {msg && <span className="note" style={{ marginLeft: 6, color: msg.ok ? "#15803d" : "#b3261e" }}>{msg.text}</span>}
    </>
  );
}
