"use client";

// The proof-succeeded dialog: the "prove it on one runner first" canary reported in on the new URL,
// so offer the fleet move. Rendered (and auto-opened) by AgentsView only while the server-side
// proof pointer is set and the canary has converged — the state lives in the agent_migration
// setting, so the dialog appears for any admin and stops appearing the moment anyone answers it.
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { confirmFleetAfterProof, dismissProof } from "../actions";

export function ProofSuccessModal({ agentName, targetUrl, othersCount }: {
  agentName: string;
  targetUrl: string;
  othersCount: number;
}) {
  const router = useRouter();
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState<"fleet" | "dismiss" | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { ref.current?.showModal(); }, []);

  async function act(kind: "fleet" | "dismiss") {
    setBusy(kind); setError(null);
    const res = kind === "fleet" ? await confirmFleetAfterProof() : await dismissProof();
    setBusy(null);
    if (!res.ok) { setError(res.error); return; }
    ref.current?.close();
    router.refresh();
  }

  return (
    // The Escape/backdrop path answers "Not now" — closing the dialog without recording an answer
    // would just re-open it on the next poll refresh.
    <dialog ref={ref} style={{ maxWidth: 480 }} onCancel={(e) => { e.preventDefault(); void act("dismiss"); }}>
      <h2>Runner migrated ✓</h2>
      <p>
        <b>{agentName}</b> has successfully migrated to <code>{targetUrl}</code>.
        {" "}Would you like to move all the other {othersCount === 1 ? "runner" : "runners"}
        {othersCount > 0 ? ` (${othersCount})` : ""} now?
      </p>
      <p className="note muted">
        Moving all enables fleet migration — every runner switches on its next heartbeat. Keep the
        old host up until each one shows migrated.
      </p>
      {error && <p className="note danger">{error}</p>}
      <div className="toolbar" style={{ marginTop: "0.75rem" }}>
        <span className="grow" />
        <button onClick={() => act("dismiss")} disabled={busy !== null}>{busy === "dismiss" ? "…" : "Not now"}</button>
        <button className="primary" onClick={() => act("fleet")} disabled={busy !== null}>
          {busy === "fleet" ? "Enabling…" : "Move all the other runners"}
        </button>
      </div>
    </dialog>
  );
}
