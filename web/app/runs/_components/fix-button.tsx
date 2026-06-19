"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { resolveOutcomes, reopenOutcomes } from "../actions";

// Mark a run-log line Fixed (resolves every occurrence of the same line for the same case) or reopen it.
export function FixButton({ fingerprint, resolved, count }: { fingerprint: string; resolved: boolean; count: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function run() {
    setErr(null);
    start(async () => {
      const res = resolved ? await reopenOutcomes(fingerprint) : await resolveOutcomes(fingerprint);
      if (!res.ok) { setErr(res.error); return; }
      router.refresh();
    });
  }

  return (
    <span style={{ whiteSpace: "nowrap" }}>
      <button
        type="button"
        onClick={run}
        disabled={pending}
        title={resolved ? "Reopen this line" : count > 1 ? `Mark Fixed — clears all ${count} occurrences of this line for this case` : "Mark this line Fixed"}
        style={{ fontSize: 11, padding: "1px 7px", color: resolved ? "#6b7280" : "#166534" }}
      >
        {pending ? "…" : resolved ? "↺ Reopen" : "✓ Fixed"}
      </button>
      {err && <span className="note danger" style={{ marginLeft: 4 }}>{err}</span>}
    </span>
  );
}
