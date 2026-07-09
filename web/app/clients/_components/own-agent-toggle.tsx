"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Toggle: run this client's CLOUD jobs (m365/exchange) on its OWN client-network agent rather than the
// central runner — for clients that authenticate the way their native script did (e.g. a Windows-store
// EXO cert that only works on their Windows box). Falls back to the central runner if the client has no
// agent. Rendered on the client detail page.
export function OwnAgentToggle({ slug, on, hasAgent }: { slug: string; on: boolean; hasAgent: boolean }) {
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
        body: JSON.stringify({ action: "set-run-cloud-on-own-agent", runCloudOnOwnAgent: !on }),
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
          ? "Cloud steps run on this client's own agent (m365/exchange included). Click to send cloud steps to the central runner instead."
          : "Click to run this client's cloud steps on its own agent (when it has one) — e.g. so a Windows-store EXO cert works. Falls back to the central runner if there's no agent."}
        style={{ cursor: "pointer", ...(on
          ? { color: "#1d4ed8", borderColor: "#bfdbfe", background: "#eff6ff" }
          : { color: "var(--muted)", opacity: 0.7 }) }}
      >
        {busy ? "…" : on ? "🖥️ cloud on own agent" : "☁️ cloud on central runner"}
      </button>
      {on && !hasAgent && <span className="note" style={{ color: "#8a6d00" }}>no agent enrolled yet — cloud steps fall back to the central runner until one is</span>}
      {error && <span className="note danger">{error}</span>}
    </span>
  );
}
