"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

type ClientOpt = { slug: string; name: string };
type PlanOutcome = { caseId: string; status: string; jobCount: number; manualCount: number; approvalCount: number };

export function CasesToolbar({ clients }: { clients: ClientOpt[] }) {
  return (
    <div className="toolbar" style={{ marginTop: "1rem" }}>
      <ImportButton />
      <NewCaseDialog clients={clients} />
    </div>
  );
}

function ImportButton() {
  const router = useRouter();
  const ref = useRef<HTMLDialogElement>(null);
  const [number, setNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<(PlanOutcome & { caseNumber: string; alreadyImported?: boolean }) | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setResult(null);
    try {
      const res = await fetch("/api/cases/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ number }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? res.statusText);
      else setResult(data.outcome ? { ...data.outcome, caseNumber: data.caseNumber, alreadyImported: data.alreadyImported } : data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="primary" onClick={() => { setNumber(""); setError(null); setResult(null); ref.current?.showModal(); }}>
        Import from ServiceNow
      </button>
      <dialog ref={ref}>
        <h2>Import from ServiceNow</h2>
        <form onSubmit={submit}>
          <label htmlFor="um">Case number</label>
          <input id="um" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="UM0028698" autoFocus />
          {busy && <p className="note"><span className="spinner" />Fetching and planning…</p>}
          {error && <p className="note danger">{error}</p>}
          {result && (
            <div style={{ marginTop: "0.5rem" }}>
              <p className="note">
                {result.alreadyImported ? "Already imported." : "Imported and planned."} {result.jobCount} jobs
                {result.manualCount ? `, ${result.manualCount} manual` : ""}
                {result.approvalCount ? `, ${result.approvalCount} need approval` : ""} · {result.status}
              </p>
            </div>
          )}
          <div className="dialog-actions">
            <button type="button" onClick={() => ref.current?.close()}>Close</button>
            {result ? (
              <button type="button" className="primary" onClick={() => { ref.current?.close(); router.push(`/cases/${result.caseId}`); }}>
                Open case
              </button>
            ) : (
              <button type="submit" className="primary" disabled={busy || !number.trim()}>Import</button>
            )}
          </div>
        </form>
      </dialog>
    </>
  );
}

function NewCaseDialog({ clients }: { clients: ClientOpt[] }) {
  const router = useRouter();
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<"onboard" | "offboard">("onboard");

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true); setError(null);
    const f = new FormData(e.currentTarget);
    const first = String(f.get("first") ?? "").trim();
    const last = String(f.get("last") ?? "").trim();
    const date = String(f.get("date") ?? "").trim();
    const payload = action === "onboard"
      ? { firstName: first, lastName: last, startDate: date || null, emailAddressNeeded: f.get("email") === "on", officeLineRequired: f.get("phone") === "on" }
      : { userToOffboard: `${first} ${last}`.trim(), dateOfOffboarding: date || null, allowedToMaintainEmail: f.get("email") === "on" };
    const subject = `${action === "onboard" ? "New User" : "Offboard"} - ${first} ${last}`.trim();
    try {
      const res = await fetch("/api/cases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientSlug: f.get("clientSlug"), action, subject, payload }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? res.statusText);
      else { ref.current?.close(); router.push(`/cases/${data.caseId}`); }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button onClick={() => { setError(null); ref.current?.showModal(); }}>New case</button>
      <dialog ref={ref}>
        <h2>New case</h2>
        <form onSubmit={submit}>
          <label htmlFor="clientSlug">Client</label>
          <select id="clientSlug" name="clientSlug" required defaultValue="">
            <option value="" disabled>Select a client…</option>
            {clients.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
          </select>

          <label htmlFor="action">Action</label>
          <select id="action" name="action" value={action} onChange={(e) => setAction(e.target.value as never)}>
            <option value="onboard">Onboard</option>
            <option value="offboard">Offboard</option>
          </select>

          <label htmlFor="first">First name</label>
          <input id="first" name="first" required />
          <label htmlFor="last">Last name</label>
          <input id="last" name="last" required />

          <label htmlFor="date">{action === "onboard" ? "Start date" : "Offboarding date"}</label>
          <input id="date" name="date" type="date" />

          <label style={{ display: "flex", gap: "0.4rem", alignItems: "center", marginTop: "0.5rem" }}>
            <input type="checkbox" name="email" style={{ width: "auto" }} />
            {action === "onboard" ? "Email account needed" : "Allowed to maintain email"}
          </label>
          {action === "onboard" && (
            <label style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
              <input type="checkbox" name="phone" style={{ width: "auto" }} /> Office line required
            </label>
          )}

          {error && <p className="note danger">{error}</p>}
          <div className="dialog-actions">
            <button type="button" onClick={() => ref.current?.close()} disabled={busy}>Cancel</button>
            <button type="submit" className="primary" disabled={busy}>{busy ? "Planning…" : "Create & plan"}</button>
          </div>
        </form>
      </dialog>
    </>
  );
}
