"use client";

// Re-plan every OPEN case of this client against its current systems — the follow-through after a
// systems edit / KB refresh. Future cases always plan fresh at creation; this catches the ones
// already imported (started cases re-plan incrementally, keeping finished steps).
import { useRouter } from "next/navigation";
import { useState } from "react";

export function ReplanCasesButton({ slug }: { slug: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <span>
      <button disabled={busy} title="Re-plan this client's open cases against the current systems (started cases keep their finished steps)"
        onClick={async () => {
          setBusy(true); setMsg(null);
          try {
            const r = await fetch(`/api/clients/${slug}/replan-cases`, { method: "POST" });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) setMsg(d.error ?? `failed (${r.status})`);
            else setMsg(d.total === 0 ? "No open cases to re-plan." : `Re-planned ${d.total} case${d.total > 1 ? "s" : ""}${d.incremental ? ` (${d.incremental} incremental)` : ""}${d.errors?.length ? ` — ${d.errors[0]}` : ""}.`);
            router.refresh();
          } catch (e) { setMsg((e as Error).message); }
          finally { setBusy(false); }
        }}>
        {busy ? "Re-planning…" : "Re-plan open cases"}
      </button>
      {msg && <span className="note" style={{ marginLeft: 8 }}>{msg}</span>}
    </span>
  );
}
