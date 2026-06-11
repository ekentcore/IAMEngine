"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

// Re-plan a case: re-pull the latest ticket + re-derive identity + re-plan against the client's
// current systems. Before execution this REPLACES the planned steps; once started it runs
// INCREMENTALLY — finished/in-flight steps are kept, and only systems without a kept step get
// fresh jobs (so KB/system changes can be adopted mid-run).
export function ReplanButton({ caseId, canReplan, started = false }: { caseId: string; canReplan: boolean; started?: boolean }) {
  const router = useRouter();
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function replan() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/cases/${caseId}/replan`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) { setMsg({ ok: false, text: data.error ?? res.statusText }); return; }
      // Success — show a brief confirmation, refresh the playbook/steps, then auto-close the modal
      // (no need to Cancel out of it).
      setMsg({
        ok: true,
        text: data.mode === "incremental"
          ? `✓ Re-plan complete — kept ${data.kept} started step${data.kept === 1 ? "" : "s"}, added ${data.added} new.`
          : "✓ Re-plan complete.",
      });
      router.refresh();
      setTimeout(() => ref.current?.close(), 1300);
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
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
          the client&apos;s current systems. Nothing executes. Use this after editing the client&apos;s
          systems (incl. dependsOn ordering), or if the ticket changed.
        </p>
        {started && (
          <p className="note" style={{ color: "#8a6d00" }}>
            This case has started: the re-plan is <b>incremental</b> — finished/in-flight steps are kept;
            only systems without a step yet get new ones. Tip: pause the case first so a runner
            doesn&apos;t claim mid-edit.
          </p>
        )}
        {msg && <p className="note" style={{ color: msg.ok ? "#15803d" : "#b91c1c" }}>{msg.text}</p>}
        <div className="dialog-actions">
          <button onClick={() => ref.current?.close()} disabled={busy}>{msg?.ok ? "Close" : "Cancel"}</button>
          <button className="primary" onClick={replan} disabled={busy || msg?.ok}>{busy ? "Re-planning…" : "Re-plan"}</button>
        </div>
      </dialog>
    </>
  );
}
