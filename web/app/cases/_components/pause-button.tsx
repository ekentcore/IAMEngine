"use client";

// Operator pause/resume for a case: paused cases are excluded from job claiming server-side, so
// the operator can edit systems / re-plan mid-run without a runner grabbing the next step.
import { useRouter } from "next/navigation";
import { useState } from "react";

export function PauseButton({ caseId, paused }: { caseId: string; paused: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      disabled={busy}
      title={paused ? "Resume — runners may claim the remaining steps again" : "Pause — runners stop claiming this case's steps until you resume (running steps finish)"}
      style={paused ? { color: "#8a6d00" } : undefined}
      onClick={async () => {
        setBusy(true);
        try {
          await fetch(`/api/cases/${caseId}/pause`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paused: !paused }) });
          router.refresh();
        } catch { /* retryable */ }
        finally { setBusy(false); }
      }}
    >
      {busy ? "…" : paused ? "▶ Resume case" : "⏸ Pause case"}
    </button>
  );
}
