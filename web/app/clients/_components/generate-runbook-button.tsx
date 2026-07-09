"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Build the runbook FROM the client's modeled systems — for internal/KB-less clients (e.g.
// Coretelligent). Replaces the onboard + offboard sections with one per participating system; the
// operator can then reorder / add steps in the runbook editor below.
export function GenerateRunbookButton({ slug }: { slug: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    if (!confirm("Build the runbook from this client's modeled systems? This replaces the current onboard AND offboard runbook sections (you can still edit them afterward).")) return;
    setBusy(true);
    setError(null);
    try {
      for (const action of ["onboard", "offboard"] as const) {
        const res = await fetch(`/api/clients/${slug}/runbook`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, fromSystems: true }),
        });
        // A 422 just means no systems participate in that action — skip it, don't fail the whole run.
        if (!res.ok && res.status !== 422) {
          const j = await res.json().catch(() => ({}));
          setError(j.error ?? `failed (${res.status})`);
          return;
        }
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
      <button onClick={generate} disabled={busy} title="Generate the runbook sections from the modeled systems (for clients with no ServiceNow KB)">
        {busy ? "Building…" : "⚙ Build from systems"}
      </button>
      {error && <span className="note danger">{error}</span>}
    </span>
  );
}
