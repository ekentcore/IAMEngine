"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

type ClientOpt = { slug: string; name: string };
type PlanFields = { personas: { name: string; titles: string[] }[]; locations: string[]; hasPlanConfig: boolean };
const EMPLOYMENT_TYPES = ["Full-Time", "Part-Time", "Contractor", "Temp"];
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
  const [dryRun, setDryRun] = useState(false); // default OFF — imports run normally unless dry-run is opted into
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
        body: JSON.stringify({ number, dryRun }),
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
          <input id="um" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="UM0028698 or INC0836187" autoFocus />
          <p className="note" style={{ marginTop: "0.25rem" }}>UM = external client case · INC = internal Coretelligent on/off-boarding incident</p>
          {!result && (
            <label style={{ display: "flex", alignItems: "center", gap: 6, margin: "0.5rem 0 0", fontSize: 13, color: "var(--fg)" }}>
              <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} style={{ width: "auto" }} />
              Import in <b>dry run</b> — plan + show the exact scripts/decisions, change nothing until you turn it off
            </label>
          )}
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
  const [clientSlug, setClientSlug] = useState("");
  const [fields, setFields] = useState<PlanFields | null>(null);
  const [role, setRole] = useState("");

  // Pull the selected client's personas/locations so the form can offer role-driven onboarding.
  useEffect(() => {
    if (!clientSlug) { setFields(null); setRole(""); return; }
    let cancelled = false;
    fetch(`/api/clients/${clientSlug}/plan-fields`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled) { setFields(d); setRole(""); } })
      .catch(() => { if (!cancelled) setFields(null); });
    return () => { cancelled = true; };
  }, [clientSlug]);

  const roleDriven = action === "onboard" && !!fields?.hasPlanConfig;
  const titles = fields?.personas.find((p) => p.name === role)?.titles ?? [];

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true); setError(null);
    const f = new FormData(e.currentTarget);
    const first = String(f.get("first") ?? "").trim();
    const last = String(f.get("last") ?? "").trim();
    const date = String(f.get("date") ?? "").trim();
    const str = (k: string) => { const v = String(f.get(k) ?? "").trim(); return v || null; };
    const payload = action === "onboard"
      ? {
          firstName: first, lastName: last, startDate: date || null,
          // v2.1 role-driven fields (drive persona/location/attribute resolution)
          department: str("role"), officeLocation: str("location"), jobTitle: str("title"),
          employmentType: str("employmentType"), managerName: str("manager"),
          emailAddressNeeded: f.get("email") === "on", officeLineRequired: f.get("phone") === "on",
        }
      : { userToOffboard: `${first} ${last}`.trim(), dateOfOffboarding: date || null, allowedToMaintainEmail: f.get("email") === "on" };
    const subject = `${action === "onboard" ? "New User" : "Offboard"} - ${first} ${last}`.trim();
    try {
      const res = await fetch("/api/cases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientSlug, action, subject, payload, dryRun: f.get("dryRun") === "on" }),
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
          <select id="clientSlug" required value={clientSlug} onChange={(e) => setClientSlug(e.target.value)}>
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

          {roleDriven && (
            <>
              <label htmlFor="role">Role</label>
              <select id="role" name="role" value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="">Select a role…</option>
                {fields!.personas.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
              </select>

              <label htmlFor="title">Title</label>
              <input id="title" name="title" list="nc-titles" placeholder={titles.length ? "Pick or type…" : "Type a title"} />
              <datalist id="nc-titles">{titles.map((t) => <option key={t} value={t} />)}</datalist>

              <label htmlFor="location">Location</label>
              <select id="location" name="location" defaultValue="">
                <option value="">Select a location…</option>
                {fields!.locations.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>

              <label htmlFor="employmentType">Employment type</label>
              <select id="employmentType" name="employmentType" defaultValue="">
                <option value="">Select…</option>
                {EMPLOYMENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>

              <label htmlFor="manager">Manager (name or DN)</label>
              <input id="manager" name="manager" placeholder="Jane Boss" />
            </>
          )}

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
          <label style={{ display: "flex", gap: "0.4rem", alignItems: "center", marginTop: "0.4rem" }}>
            <input type="checkbox" name="dryRun" style={{ width: "auto" }} /> Dry run (-WhatIf — no changes; you can flip this on the case later)
          </label>

          {roleDriven && <p className="note" style={{ marginTop: "0.5rem" }}>Role/location/title drive the resolved OU, groups, and attributes — review them in the playbook after planning.</p>}
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
