"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

// A case whose Dry-run toggle is locked (a step has already started under dry-run) has no other UI
// path to a real run — this clears dry-run, unpauses the case, and re-queues its already-run api
// steps to execute for real (the same effect as the manual SQL it replaces).
export function ExitDryRunButton({ caseId }: { caseId: string }) {
  const router = useRouter();
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(`/api/cases/${caseId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "exit-dry-run" }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg(d.error ?? `failed (${r.status})`); return; }
      ref.current?.close();
      router.refresh();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span>
      <button onClick={() => { setMsg(null); ref.current?.showModal(); }} title="Clear dry run and re-run this case's steps against the real systems">
        Turn off dry run &amp; run for real
      </button>
      <dialog ref={ref}>
        <h2 style={{ marginTop: 0 }}>Run this case for real?</h2>
        <p className="note">
          This clears dry-run mode and re-queues the case&apos;s automated steps to execute against the
          real systems (creating/changing accounts, licenses, etc.). Manual steps are unchanged.
        </p>
        {msg && <p className="note" style={{ color: "#b91c1c" }}>{msg}</p>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={() => ref.current?.close()} disabled={busy}>Cancel</button>
          <button onClick={go} disabled={busy}>{busy ? "Starting…" : "Yes, run for real"}</button>
        </div>
      </dialog>
    </span>
  );
}
