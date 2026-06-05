"use client";

// Toggle a case between LIVE and DRY RUN. In dry-run, dispatched jobs run -WhatIf — the runner
// connects, validates read-only, and changes nothing. Disabled once a job has started (you can't
// switch mode mid-run; re-plan to reset). Persists onto every pending job's request.dryRun.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export function DryRunToggle({ caseId, dryRun, locked }: { caseId: string; dryRun: boolean; locked: boolean }) {
  const router = useRouter();
  const [on, setOn] = useState(dryRun);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reconcile with the server after a router.refresh() (or an external change) — the prop is authoritative.
  useEffect(() => { setOn(dryRun); }, [dryRun]);

  async function set(next: boolean) {
    setBusy(true); setError(null);
    const r = await fetch(`/api/cases/${caseId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "set-dry-run", dryRun: next }) });
    setBusy(false);
    if (!r.ok) { setError((await r.json().catch(() => ({})))?.error ?? `failed (${r.status})`); return; }
    setOn(next);
    router.refresh();
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
      <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", cursor: locked ? "default" : "pointer" }} title={locked ? "A job has already started — re-plan to change the mode." : ""}>
        <input type="checkbox" checked={on} disabled={busy || locked} onChange={(e) => set(e.target.checked)} style={{ width: "auto" }} />
        <b style={{ color: on ? "#7b3fa0" : undefined }}>Dry run</b>
      </label>
      <span className="badge" style={on ? { color: "#7b3fa0", borderColor: "#e0cef0", background: "#f8f3fc" } : { color: "#b3261e", borderColor: "#f0c4c1", background: "#fdf3f2" }}>
        {on ? "dry run · -WhatIf, no changes" : "LIVE · will make changes"}
      </span>
      {locked && <span className="note">locked — a job has started</span>}
      {error && <span className="note danger">{error}</span>}
    </div>
  );
}
