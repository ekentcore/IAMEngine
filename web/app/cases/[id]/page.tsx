// Case detail (server component): the pre-flight dry-run playbook, the after-action run report,
// the planned/ordered job list, manual checklist, and the intake payload.
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { makeCaseRepository } from "@/lib/cases/repository";
import { currentClientScope, scopeAllows } from "@/lib/auth/client-scope";
import { intakeLabel } from "@/lib/cases/intake-labels";
import { loadPlaybook } from "@/lib/cases/playbook";
import { loadRunReport } from "@/lib/cases/run-report";
import { writeBackEnabled } from "@/lib/servicenow/worknote";
import { PlaybookView } from "../_components/playbook-view";
import { CaseSecretsPanel } from "../_components/case-secrets-panel";
import { RunReportView } from "../_components/run-report-view";
import { ReplanButton } from "../_components/replan-button";
import { RescanButton } from "../_components/rescan-button";
import { RevealPasswordButton } from "../_components/reveal-password-button";
import { HardMatchButton } from "../_components/hard-match-button";
import { DryRunToggle } from "../_components/dry-run-toggle";
import { PauseButton } from "../_components/pause-button";
import { IntakePanel } from "../_components/intake-panel";
import { hasStartedJobs } from "@/lib/cases/job-status";

export const dynamic = "force-dynamic";

// Tab title = the UM number (or subject), so open case tabs are tellable apart.
export async function generateMetadata({ params }: { params: { id: string } }) {
  const c = await db.caseRequest.findUnique({ where: { id: params.id }, select: { clientId: true, serviceNowCaseNumber: true, subject: true } });
  // Don't leak an out-of-scope case's subject in the tab title (the page itself 404s).
  if (c && !scopeAllows(await currentClientScope(db), c.clientId)) return { title: "Case" };
  return { title: c?.serviceNowCaseNumber ?? c?.subject ?? "Case" };
}

// One intake value cell. Scalars render inline; arrays comma-join; a NESTED OBJECT (e.g. the derived
// `templateFields` email-template map, or an array of objects) is rendered as readable "key: value"
// lines instead of the old `String(v)` fallback that produced a literal "[object Object]".
function fmtScalar(x: unknown): string {
  if (x === null || x === undefined || x === "") return "—";
  if (typeof x === "boolean") return x ? "yes" : "no";
  return String(x);
}
function IntakeValue({ v }: { v: unknown }) {
  if (v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) return <span className="muted">—</span>;
  if (typeof v === "boolean") return <>{v ? "yes" : "no"}</>;
  if (Array.isArray(v)) {
    if (v.some((x) => x && typeof x === "object")) {
      return <>{v.map((x, i) => <div key={i}>{x && typeof x === "object" ? Object.entries(x).map(([k, vv]) => `${k}: ${fmtScalar(vv)}`).join(" · ") : String(x)}</div>)}</>;
    }
    return <>{v.map(String).join(", ")}</>;
  }
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length === 0) return <span className="muted">—</span>;
    return (
      <div style={{ display: "grid", gap: 2 }}>
        {entries.map(([k, vv]) => <div key={k}><span className="muted">{k}:</span> {fmtScalar(vv)}</div>)}
      </div>
    );
  }
  return <>{String(v)}</>;
}

export default async function CaseDetailPage({ params }: { params: { id: string } }) {
  // scope-gated: a case of an out-of-scope (e.g. restricted) client reads as not-found here.
  const scope = await currentClientScope(db);
  const c = await makeCaseRepository(db).getCase(params.id, scope);
  if (!c) notFound();

  const [playbook, runReport] = await Promise.all([loadPlaybook(db, params.id), loadRunReport(db, params.id)]);
  const writeEnabled = writeBackEnabled();

  const manual = c.jobs.filter((j) => j.isManual);
  const automated = c.jobs.filter((j) => !j.isManual);
  // Re-plan is always available: before dispatch it's a full re-plan; once started it runs
  // incrementally (kept steps survive, new/changed systems get fresh jobs).
  const started = hasStartedJobs(c.jobs);
  const caseMeta = await db.caseRequest.findUnique({ where: { id: params.id }, select: { pausedAt: true, initialPassword: true } });
  const paused = Boolean(caseMeta?.pausedAt);
  const hasInitialPassword = Boolean(caseMeta?.initialPassword);
  // Hybrid duplicate flag: the consistency check flagged an unlinked/duplicate risk, and no hard-match
  // has been dispatched yet → offer the operator-confirmed "Link" action.
  const dJobs = await db.job.findMany({ where: { caseRequestId: params.id, systemKey: { in: ["ad-consistency-check", "ad-hard-match"] } }, select: { systemKey: true, result: true } });
  const showHardMatch = dJobs.some((j) => j.systemKey === "ad-consistency-check" && Boolean((j.result as { Flagged?: unknown } | null)?.Flagged))
    && !dJobs.some((j) => j.systemKey === "ad-hard-match");

  return (
    <main>
      {/* Sticky slot: the run report portals the "current step" banner here so it stays visible under
          the title no matter where you've scrolled on the case. Empty (0-height) when nothing runs. */}
      <div id="case-running-banner-slot" style={{ position: "sticky", top: 0, zIndex: 30, margin: "0 0 0.25rem", borderRadius: 4, overflow: "hidden" }} />
      <p className="note"><Link href="/cases">← Cases</Link></p>
      <div className="row-between">
        <div>
          <h1>{c.subject ?? "Case"}</h1>
          <p className="note">
            <Link href={`/clients/${c.client.slug}`}>{c.client.name}</Link> · {c.action} ·{" "}
            {c.serviceNowCaseNumber ?? "no SN case"} · <span className="badge">{c.status.replace("_", " ")}</span>
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {showHardMatch && <HardMatchButton caseId={c.id} />}
          {hasInitialPassword && <RevealPasswordButton caseId={c.id} />}
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

      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ marginBottom: 0 }}>Intake details</h2>
        {c.serviceNowCaseNumber && <RescanButton caseId={c.id} caseNumber={c.serviceNowCaseNumber} />}
      </div>
      <p className="note" style={{ marginTop: "0.25rem" }}>The fields from the ServiceNow request that drive this case&apos;s plan.</p>
      <table>
        <tbody>
          {Object.entries(c.payload).map(([k, v]) => (
            <tr key={k}>
              <th style={{ width: 240 }}>{intakeLabel(k)}</th>
              <td>
                <IntakeValue v={v} />
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
