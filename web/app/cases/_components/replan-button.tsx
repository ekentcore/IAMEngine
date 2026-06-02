"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

// Re-plan a case: re-pull the latest ticket + re-derive identity + re-plan against the client's
// current systems, replacing the planned steps. Pre-execution only.
export function ReplanButton({ caseId, canReplan }: { caseId: string; canReplan: boolean }) {
  const router = useRouter();
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function replan() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/cases/${caseId}/replan`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) setMsg(data.error ?? res.statusText);
      else {
        ref.current?.close();
        router.refresh(); // pull the freshly-planned playbook + steps
        return;
      }
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!canReplan) {
    return <button disabled title="Re-plan is only available before the case starts executing">Re-plan</button>;
  }
  return (
    <>
      <button onClick={() => { setMsg(null); ref.current?.showModal(); }}>Re-plan</button>
      <dialog ref={ref}>
        <h2>Re-plan this case</h2>
        <p className="note">
          Re-pulls the latest ServiceNow ticket, re-derives the user identity, and re-plans against
          the client&apos;s current systems — replacing the planned steps. Nothing executes. Use this
          after editing the client&apos;s systems, or if the ticket changed.
        </p>
        {msg && <p className="note danger">{msg}</p>}
        <div className="dialog-actions">
          <button onClick={() => ref.current?.close()} disabled={busy}>Cancel</button>
          <button className="primary" onClick={replan} disabled={busy}>{busy ? "Re-planning…" : "Re-plan"}</button>
        </div>
      </dialog>
    </>
  );
}
