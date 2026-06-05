// Case detail (server component): the pre-flight dry-run playbook, the after-action run report,
// the planned/ordered job list, manual checklist, and the intake payload.
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { makeCaseRepository } from "@/lib/cases/repository";
import { loadPlaybook } from "@/lib/cases/playbook";
import { loadRunReport } from "@/lib/cases/run-report";
import { writeBackEnabled } from "@/lib/servicenow/worknote";
import { PlaybookView } from "../_components/playbook-view";
import { CaseSecretsPanel } from "../_components/case-secrets-panel";
import { RunReportView } from "../_components/run-report-view";
import { ReplanButton } from "../_components/replan-button";
import { IntakePanel } from "../_components/intake-panel";
import { hasStartedJobs } from "@/lib/cases/job-status";

export const dynamic = "force-dynamic";

export default async function CaseDetailPage({ params }: { params: { id: string } }) {
  const c = await makeCaseRepository(db).getCase(params.id);
  if (!c) notFound();

  const [playbook, runReport] = await Promise.all([loadPlaybook(db, params.id), loadRunReport(db, params.id)]);
  const writeEnabled = writeBackEnabled();

  const manual = c.jobs.filter((j) => j.isManual);
  const automated = c.jobs.filter((j) => !j.isManual);
  const canReplan = !hasStartedJobs(c.jobs);

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
        <ReplanButton caseId={c.id} canReplan={canReplan} />
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

      <h2>Planned identity</h2>
      <table>
        <tbody>
          {Object.entries(c.payload).map(([k, v]) => (
            <tr key={k}>
              <th style={{ width: 240 }}>{k}</th>
              <td>{v === null || v === "" ? <span className="muted">—</span> : String(typeof v === "boolean" ? (v ? "yes" : "no") : v)}</td>
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
