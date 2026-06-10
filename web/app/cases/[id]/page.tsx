// Case detail (server component): the pre-flight dry-run playbook, the after-action run report,
// the planned/ordered job list, manual checklist, and the intake payload.
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { makeCaseRepository } from "@/lib/cases/repository";
import { intakeLabel } from "@/lib/cases/intake-labels";
import { loadPlaybook } from "@/lib/cases/playbook";
import { loadRunReport } from "@/lib/cases/run-report";
import { writeBackEnabled } from "@/lib/servicenow/worknote";
import { PlaybookView } from "../_components/playbook-view";
import { CaseSecretsPanel } from "../_components/case-secrets-panel";
import { RunReportView } from "../_components/run-report-view";
import { ReplanButton } from "../_components/replan-button";
import { DryRunToggle } from "../_components/dry-run-toggle";
import { PauseButton } from "../_components/pause-button";
import { IntakePanel } from "../_components/intake-panel";
import { hasStartedJobs } from "@/lib/cases/job-status";

export const dynamic = "force-dynamic";

// Tab title = the UM number (or subject), so open case tabs are tellable apart.
export async function generateMetadata({ params }: { params: { id: string } }) {
  const c = await db.caseRequest.findUnique({ where: { id: params.id }, select: { serviceNowCaseNumber: true, subject: true } });
  return { title: c?.serviceNowCaseNumber ?? c?.subject ?? "Case" };
}

export default async function CaseDetailPage({ params }: { params: { id: string } }) {
  const c = await makeCaseRepository(db).getCase(params.id);
  if (!c) notFound();

  const [playbook, runReport] = await Promise.all([loadPlaybook(db, params.id), loadRunReport(db, params.id)]);
  const writeEnabled = writeBackEnabled();

  const manual = c.jobs.filter((j) => j.isManual);
  const automated = c.jobs.filter((j) => !j.isManual);
  // Re-plan is always available: before dispatch it's a full re-plan; once started it runs
  // incrementally (kept steps survive, new/changed systems get fresh jobs).
  const started = hasStartedJobs(c.jobs);
  const paused = Boolean((await db.caseRequest.findUnique({ where: { id: params.id }, select: { pausedAt: true } }))?.pausedAt);

  return (
    <main>
      <p className="note"><Link href="/cases">← Cases</Link></p>
      <div className="row-between">
        <div>
          <h1>{c.subject ?? "Case"}</h1>
          <p className="note">
            <Link href={`/clients/${c.client.slug}`}>{c.client.name}</Link> · {c.action} ·{" "}
            {c.serviceNowCaseNumber ?? "no SN case"} · <span className="badge">{c.status.replace("_", " ")}</span>
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <PauseButton caseId={c.id} paused={paused} />
          <ReplanButton caseId={c.id} canReplan={true} started={started} />
        </div>
      </div>
      {paused && (
        <p className="note" style={{ color: "#8a6d00" }}>
          ⏸ This case is paused — runners won&rsquo;t claim its steps until you resume (a step already running finishes normally).
        </p>
      )}

      <div style={{ margin: "0.5rem 0 1rem" }}>
        <DryRunToggle caseId={c.id} dryRun={c.dryRun} locked={started} />
      </div>

      {playbook && playbook.steps.length > 0 && (
        <>
          <h2>Playbook (dry run)</h2>
          <PlaybookView playbook={playbook} caseId={c.id} />
        </>
      )}

      <h2>Credentials</h2>
      <CaseSecretsPanel caseId={c.id} />

      {runReport && runReport.steps.length > 0 && (
        <>
          <h2>Run report</h2>
          <RunReportView initial={runReport} caseId={c.id} writeEnabled={writeEnabled} />
        </>
      )}

      <h2>Planned steps ({c.jobs.length})</h2>
      {c.jobs.length === 0 ? (
        <p className="note">No steps planned — no systems matched this client + action.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>System</th>
              <th>Mode</th>
              <th>Type</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {c.jobs.map((j) => (
              <tr key={j.id}>
                <td className="muted">{j.sequence + 1}</td>
                <td>{j.systemName} <span className="note">({j.systemKey})</span></td>
                <td><span className="badge">{j.mode}</span></td>
                <td className="muted">
                  {j.isManual ? "manual / checklist" : "automated"}
                  {j.requiresApproval && <span className="badge archived" style={{ marginLeft: 6 }}>approval</span>}
                </td>
                <td><span className="badge">{j.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {manual.length > 0 && (
        <>
          <h2>Manual checklist ({manual.length})</h2>
          <ul className="note">
            {manual.map((j) => <li key={j.id}>{j.systemName} — {j.mode}</li>)}
          </ul>
        </>
      )}

      {c.serviceNowCaseNumber && (
        <>
          <h2>Intake form ({c.serviceNowCaseNumber})</h2>
          <p className="note">Live from ServiceNow — what the requester filled in, and what they left blank.</p>
          <IntakePanel caseId={c.id} />
        </>
      )}

      <h2>Intake details</h2>
      <p className="note" style={{ marginTop: "-0.5rem" }}>The fields from the ServiceNow request that drive this case&apos;s plan.</p>
      <table>
        <tbody>
          {Object.entries(c.payload).map(([k, v]) => (
            <tr key={k}>
              <th style={{ width: 240 }}>{intakeLabel(k)}</th>
              <td>
                {v === null || v === "" || (Array.isArray(v) && v.length === 0)
                  ? <span className="muted">—</span>
                  : typeof v === "boolean" ? (v ? "yes" : "no")
                  : Array.isArray(v) ? v.map(String).join(", ")
                  : String(v)}
              </td>
            </tr>
          ))}
          {Object.keys(c.payload).length === 0 && (
            <tr><td className="muted">No intake fields.</td></tr>
          )}
        </tbody>
      </table>
      <p className="note" style={{ marginTop: "1rem" }}>
        {automated.length} automated, {manual.length} manual. Review the playbook before dispatch; the run report tracks execution.
      </p>
    </main>
  );
}
