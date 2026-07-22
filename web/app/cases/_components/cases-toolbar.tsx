"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { ScanResult } from "@/lib/cases/sn-completion";

type ClientOpt = { slug: string; name: string };
type PlanFields = { personas: { name: string; titles: string[] }[]; locations: string[]; hasPlanConfig: boolean };
const EMPLOYMENT_TYPES = ["Full-Time", "Part-Time", "Contractor", "Temp"];
type PlanOutcome = { caseId: string; status: string; jobCount: number; manualCount: number; approvalCount: number };

export function CasesToolbar({ clients, snScan = false }: { clients: ClientOpt[]; snScan?: boolean }) {
  return (
    <div className="toolbar" style={{ marginTop: "1rem" }}>
      <ImportButton />
      <NewCaseDialog clients={clients} />
      {snScan && <ScanServiceNowButton />}
      <span className="grow" />
      <AutoImportToggle />
    </div>
  );
}

// Scan every open case's ServiceNow ticket; tickets that are resolved/closed come back in a confirm
// dialog where the operator picks which cases to mark completed (all steps → succeeded, undoable
// per step on the case page; the case moves to the Completed table).
function ScanServiceNowButton() {
  const router = useRouter();
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [marking, setMarking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [failures, setFailures] = useState<{ id: string; caseNumber: string; error: string }[]>([]);

  async function scanNow() {
    setBusy(true); setError(null); setScan(null); setFailures([]); setChecked(new Set());
    ref.current?.showModal();
    try {
      const r = await fetch("/api/cases/scan-servicenow", { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error ?? `failed (${r.status})`); return; }
      setScan(d);
      setChecked(new Set((d as ScanResult).resolved.map((c) => c.id)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function toggleCase(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function markCompleted() {
    if (!scan) return;
    setMarking(true); setFailures([]);
    const picked = scan.resolved.filter((c) => checked.has(c.id));
    const failed: { id: string; caseNumber: string; error: string }[] = [];
    for (const c of picked) {
      try {
        const r = await fetch(`/api/cases/${c.id}/complete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ snState: c.snState }),
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          failed.push({ id: c.id, caseNumber: c.caseNumber, error: d.error ?? `failed (${r.status})` });
        }
      } catch (e) {
        failed.push({ id: c.id, caseNumber: c.caseNumber, error: (e as Error).message });
      }
    }
    setMarking(false);
    if (failed.length) {
      // Drop the ones that DID complete from the list so a retry only re-sends the failures.
      setFailures(failed);
      const failedIds = new Set(failed.map((f) => f.id));
      setScan((p) => (p ? { ...p, resolved: p.resolved.filter((c) => failedIds.has(c.id)) } : p));
      router.refresh();
    } else {
      ref.current?.close();
      router.refresh();
    }
  }

  const pickedCount = scan ? scan.resolved.filter((c) => checked.has(c.id)).length : 0;

  return (
    <>
      <button onClick={scanNow} disabled={busy} title="Check every open case's ServiceNow ticket; offer to mark the resolved/closed ones completed">
        {busy ? "Checking…" : "Check ServiceNow"}
      </button>
      <dialog ref={ref} style={{ minWidth: "min(560px, 90vw)" }}>
        <h2>Resolved in ServiceNow</h2>
        {busy && <p className="note"><span className="spinner" />Checking open cases against ServiceNow…</p>}
        {error && <p className="note danger">{error}</p>}
        {scan && !busy && (
          <>
            {scan.resolved.length === 0 ? (
              <p className="note">Checked {scan.scanned} open case{scan.scanned === 1 ? "" : "s"} — none are resolved or closed in ServiceNow.</p>
            ) : (
              <>
                <p className="note">
                  {scan.resolved.length} of {scan.scanned} open case{scan.scanned === 1 ? "" : "s"} {scan.resolved.length === 1 ? "is" : "are"} resolved or closed in ServiceNow.
                  Marking a case completed sets every remaining step to completed (each step stays undoable on the case page) and moves it to the Completed table.
                </p>
                <ul style={{ listStyle: "none", padding: 0, margin: "0.5rem 0", maxHeight: "45vh", overflowY: "auto" }}>
                  {scan.resolved.map((c) => (
                    <li key={c.id} style={{ padding: "0.3rem 0" }}>
                      <label style={{ display: "flex", gap: 8, alignItems: "baseline", cursor: "pointer" }}>
                        <input type="checkbox" checked={checked.has(c.id)} onChange={() => toggleCase(c.id)} style={{ width: "auto" }} />
                        <span>
                          <b>{c.caseNumber}</b> · {c.clientName} · {c.subject ?? "(no subject)"}
                          <span className="note" style={{ display: "block" }}>ServiceNow: {c.snState} · case is {c.status.replace("_", " ")}</span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {scan.cancelled.length > 0 && (
              <p className="note">
                Closed without the work being done (not offered for completion): {scan.cancelled.map((c) => `${c.caseNumber} (${c.snState})`).join(", ")} — review these on their case pages.
              </p>
            )}
            {scan.errors.length > 0 && (
              <p className="note danger">Couldn’t check: {scan.errors.map((e) => e.caseNumber).join(", ")}</p>
            )}
            {failures.length > 0 && (
              <p className="note danger">Failed to complete: {failures.map((f) => `${f.caseNumber} (${f.error})`).join("; ")}</p>
            )}
          </>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={() => ref.current?.close()} disabled={marking}>Close</button>
          {scan && scan.resolved.length > 0 && (
            <button type="button" className="primary" onClick={markCompleted} disabled={marking || pickedCount === 0}>
              {marking ? "Marking…" : `Mark ${pickedCount} completed`}
            </button>
          )}
        </div>
      </dialog>
    </>
  );
}

// Turn the automated ServiceNow intake poller on/off. When on, heartbeats pull open/unassigned UM
// tickets + internal on/off-boarding incidents ~every 15 min and auto-import + plan them (held for review).
function AutoImportToggle() {
  const router = useRouter();
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [info, setInfo] = useState<{ lastRunAt?: string; imported?: number; lastRunImported?: number } | null>(null);
  useEffect(() => { fetch("/api/admin/intake").then((r) => (r.ok ? r.json() : null)).then((d) => { if (d) { setOn(Boolean(d.enabled)); setInfo(d); } }).catch(() => {}); }, []);
  if (on === null) return null; // not loaded / not permitted
  async function toggle() {
    setBusy(true);
    try {
      const r = await fetch("/api/admin/intake", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !on }) });
      if (r.ok) setOn(!on);
    } finally { setBusy(false); }
  }
  // Run the sweep on demand (ignores the ~15-min throttle + the enabled flag) and surface the result.
  async function importNow() {
    setRunning(true); setMsg(null);
    try {
      const r = await fetch("/api/admin/intake", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "import-now" }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg({ ok: false, text: d.error ?? `failed (${r.status})` }); return; }
      if (d.setting) setInfo((p) => ({ ...(p ?? {}), ...d.setting }));
      setMsg({ ok: true, text: `Imported ${d.imported} new of ${d.scanned} open${d.alreadyImported ? `, ${d.alreadyImported} already imported` : ""}${d.skipped ? `, ${d.skipped} skipped (do not use engine)` : ""}${d.failed ? `, ${d.failed} failed` : ""}.` });
      if (d.imported > 0) router.refresh(); // surface the new cases in the list
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally { setRunning(false); }
  }
  const last = info?.lastRunAt ? `last run ${new Date(info.lastRunAt).toLocaleTimeString()}${typeof info.lastRunImported === "number" ? `, ${info.lastRunImported} imported` : info.imported ? `, ${info.imported} imported` : ""}` : "not run yet";
  return (
    <span style={{ display: "inline-flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
      <button onClick={importNow} disabled={running} title="Pull open/unassigned ServiceNow UMs + incidents now and import any new ones (held for review)">
        {running ? "Importing…" : "Import now"}
      </button>
      <label className="note" style={{ display: "inline-flex", gap: 6, alignItems: "center" }} title={`Auto-import open/unassigned ServiceNow tickets every ~15 min (held for review). ${last}.`}>
        <input type="checkbox" checked={on} disabled={busy} onChange={toggle} style={{ width: "auto" }} />
        Auto-import from ServiceNow {on && <span className="muted">· {last}</span>}
      </label>
      {msg && <span className="note" style={{ color: msg.ok ? "#15803d" : "#b91c1c" }}>{msg.text}</span>}
    </span>
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
        body: JSON.stringify({ number, dryRun: false }),
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
      : { userToOffboard: `${first} ${last}`.trim(), dateOfOffboarding: date || null, allowedToMaintainEmail: f.get("email") === "on", skipGalHide: f.get("skipGalHide") === "on" };
    const subject = `${action === "onboard" ? "New User" : "Offboard"} - ${first} ${last}`.trim();
    try {
      const res = await fetch("/api/cases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientSlug, action, subject, payload, dryRun: false }),
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
          {action === "offboard" && (
            <label style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
              <input type="checkbox" name="skipGalHide" style={{ width: "auto" }} /> Keep in global address list (skip GAL hide)
            </label>
          )}
          {action === "onboard" && (
            <label style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
              <input type="checkbox" name="phone" style={{ width: "auto" }} /> Office line required
            </label>
          )}
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
