"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { intakeLabel } from "@/lib/cases/intake-labels";

// Re-pull the latest ServiceNow ticket (UM or INC) and refresh this case's Intake details fields.
// Refresh only — it does NOT re-plan; once the fields look right, use Re-plan to regenerate the
// playbook on them. Shown only for ServiceNow-sourced cases (caseNumber present).
export function RescanButton({ caseId, caseNumber }: { caseId: string; caseNumber: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function rescan() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/cases/${caseId}/rescan`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) { setMsg({ ok: false, text: data.error ?? res.statusText }); return; }
      const changed: string[] = data.changed ?? [];
      setMsg({
        ok: true,
        text: changed.length === 0
          ? `No changes — ${caseNumber} matches the stored fields.`
          : `Updated ${changed.length} field${changed.length === 1 ? "" : "s"} from ${caseNumber}: ${changed.map(intakeLabel).join(", ")}. Re-plan to apply.`,
      });
      router.refresh(); // re-render the Intake details table with the refreshed values
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      <button onClick={rescan} disabled={busy} title={`Re-pull ${caseNumber} from ServiceNow and refresh these fields (does not re-plan)`}>
        {busy ? "Rescanning…" : "Rescan"}
      </button>
      {msg && <span className="note" style={{ color: msg.ok ? "#15803d" : "#b91c1c" }}>{msg.text}</span>}
    </span>
  );
}
