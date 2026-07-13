"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Toggle: "do not use engine" — this client's ServiceNow cases are never imported (the intake
// sweep skips them, a manual import refuses). Cases already imported are untouched. Rendered on
// the client detail page next to the other per-client flags.
export function EngineOptOutToggle({ slug, name, on }: { slug: string; name: string; on: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    if (!on && !confirm(`Stop importing ${name}'s ServiceNow cases into the engine? Open and future tickets will be skipped by the intake sweep (cases already imported are kept).`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/clients/${slug}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "set-engine-opt-out", engineOptOut: !on }),
      });
      if (!res.ok) { setError((await res.json().catch(() => ({}))).error ?? "could not update"); return; }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <button
        type="button"
        className="badge"
        disabled={busy}
        onClick={toggle}
        title={on
          ? "Do not use engine: this client's ServiceNow cases are NOT imported (intake sweep skips them). Click to resume importing."
          : "Click to stop importing this client's ServiceNow cases into the engine — for clients handled entirely outside it."}
        style={{ cursor: "pointer", ...(on
          ? { color: "var(--err-fg)", borderColor: "var(--err-bg)", background: "var(--err-bg)" }
          : { color: "var(--muted)", opacity: 0.7 }) }}
      >
        {busy ? "…" : on ? "⛔ do not use engine" : "⚙️ engine in use"}
      </button>
      {error && <span className="note danger">{error}</span>}
    </span>
  );
}
