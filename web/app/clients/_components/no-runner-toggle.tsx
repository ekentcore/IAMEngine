"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Toggle: flag this client as having NO runner/agent at all (e.g. Dianthus) — the Fleet M365 sweep
// (and any other fleet-wide job enumeration) skips it entirely, so it never queues connection tests
// that would just sit pending forever with nothing to claim them. Rendered on the client detail page.
export function NoRunnerToggle({ slug, on }: { slug: string; on: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/clients/${slug}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "set-no-runner", noRunner: !on }),
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
        title="Fleet sweeps skip this client (no agent will ever serve it)."
        style={{ cursor: "pointer", ...(on
          ? { color: "#b45309", borderColor: "#fde68a", background: "#fffbeb" }
          : { color: "var(--muted)", opacity: 0.7 }) }}
      >
        {busy ? "…" : on ? "🚫 no runner" : "no runner"}
      </button>
      {error && <span className="note danger">{error}</span>}
    </span>
  );
}
