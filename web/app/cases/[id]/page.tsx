// Case detail (server component): the pre-flight dry-run playbook, the after-action run report,
// the planned/ordered job list, manual checklist, and the intake payload.
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { makeCaseRepository } from "@/lib/cases/repository";
import { currentClientScope, scopeAllows } from "@/lib/auth/client-scope";
import { authEnabled, getActingContext } from "@/lib/auth/current-user";
import { can } from "@/lib/auth/permissions";
import { intakeLabel } from "@/lib/cases/intake-labels";
import { CASE_SOURCE_LABEL } from "@/lib/cases/case-source";
import { loadPlaybook } from "@/lib/cases/playbook";
import { loadRunReport } from "@/lib/cases/run-report";
import { writeBackEnabled } from "@/lib/servicenow/worknote";
import { PlaybookView } from "../_components/playbook-view";
import { CaseSecretsPanel } from "../_components/case-secrets-panel";
import { RunReportView } from "../_components/run-report-view";
import { ChangePreview } from "../_components/change-preview";
import { buildChangeDiffs } from "@/lib/cases/change-service";
import type { ChangePayload } from "@/lib/cases/change-types";
import { CaseActionsMenu } from "../_components/case-actions-menu";
import { RescanButton } from "../_components/rescan-button";
import { ExitDryRunButton } from "../_components/exit-dry-run-button";
import { LocalDateTime } from "../../_components/local-datetime";
import { CollapsibleSection } from "../../_components/collapsible-section";
import { caseEffectiveDate } from "@/lib/cases/schedule";
import { IntakePanel } from "../_components/intake-panel";
import { hasStartedJobs } from "@/lib/cases/job-status";
import { isMilestoneCase } from "@/lib/eggs/occasions";
import { pickResetSourceJob } from "@/lib/jobs/password-reset";

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
  const caseMeta = await db.caseRequest.findUnique({ where: { id: params.id }, select: { pausedAt: true, pausedReason: true, initialPassword: true, scheduledFor: true } });
  const paused = Boolean(caseMeta?.pausedAt);
  // Mirror the reveal route's guard (case.dispatch, no impersonation) so read-only roles don't see
  // a button the server will 403 — the route stays the real boundary.
  const acting = authEnabled() ? await getActingContext() : { user: null, realUser: null, impersonating: false };
  const canRevealPassword = !authEnabled() || (!!acting.user && !acting.impersonating && can(acting.user.role, "case.dispatch"));
  const hasInitialPassword = Boolean(caseMeta?.initialPassword) && canRevealPassword;
  // FR#31: offer "reset password" from the Actions menu even before any step has run (imported
  // cases pause on import, and the reset route already supports paused cases) — pick whichever
  // planned job the ad-hoc reset job should ride on. Excluded for dry runs: nothing in a dry-run
  // case ever actually dispatches, so there's no real account yet to reset a password on.
  // The backbone decides WHICH directory the reset lands in: a Google-backbone client with an M365
  // lane must reset in Google, not M365 (FR #0000080).
  const resetSourceJobId = c.dryRun ? null : pickResetSourceJob(c.jobs, c.client.backbone);
  const resetSourceJob = resetSourceJobId ? c.jobs.find((j) => j.id === resetSourceJobId) ?? null : null;
  const scheduledForIso = caseMeta?.scheduledFor?.toISOString() ?? null;
  // The case's effective date string — the ScheduleButton computes its suggested time from this in
  // the BROWSER (so "08:00" / "+5 min" land in the operator's timezone, not the server's).
  const effectiveDate = caseEffectiveDate(c.action, c.payload, c.subject);

  // Multi-domain clients: the domains this case may onboard under + the persisted per-case pick.
  const domainRow = c.action === "onboard"
    ? await db.caseRequest.findUnique({
        where: { id: c.id },
        select: { emailDomainOverride: true, client: { select: { domains: true, emailDomain: true, primaryDomain: true } } },
      })
    : null;
  const domainInfo = domainRow
    ? {
        options: [...new Set([...(domainRow.client.domains ?? []), domainRow.client.emailDomain, domainRow.client.primaryDomain].filter((d): d is string => Boolean(d)).map((d) => d.toLowerCase()))],
        defaultDomain: (domainRow.client.emailDomain ?? domainRow.client.primaryDomain ?? null)?.toLowerCase() ?? null,
        override: domainRow.emailDomainOverride,
      }
    : null;
  // A "change" (mover) case held for review: compute the per-system add/remove diff server-side so
  // the ChangePreview modal can let the operator pick scoped/full/add-only before anything dispatches.
  // Mirrors createChangeCase's own client fetch (buildChangeDiffs takes the SAME clientForPlanning
  // shape uncast there); "review" is the exact hold reason change-service.ts sets on an unconfirmed mover.
  const changePreviewDiffs = c.action === "change" && caseMeta?.pausedReason === "review"
    ? await (async () => {
        const planClient = await makeCaseRepository(db).clientForPlanning(c.client.slug);
        if (!planClient) return null;
        const diffs = buildChangeDiffs(planClient, c.payload as unknown as ChangePayload);
        return diffs.map((d) => ({ systemKey: d.systemKey, add: d.add, removeGroups: d.removeGroups, moveToOu: d.moveToOu }));
      })()
    : null;

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
            {c.serviceNowCaseNumber ?? "no SN case"}
            {isMilestoneCase(c.serviceNowCaseNumber) && <span title="milestone case" aria-label="milestone case"> ✨</span>}
            {" · "}<span className="badge">{c.status.replace("_", " ")}</span>
            {(() => {
              const rule = (c.payload as { __intakeRule?: { label?: string } } | null)?.__intakeRule;
              return rule?.label ? <span className="badge" style={{ marginLeft: 6 }} title="This case was planned by a per-contact intake rule">Intake rule: {rule.label}</span> : null;
            })()}
          </p>
          <p className="note">
            {CASE_SOURCE_LABEL[c.createdSource]} {c.createdBy ? <>by <b>{c.createdBy}</b></> : <span className="muted">— creator not recorded</span>}
            {" · "}{c.createdAt.toLocaleString()}
          </p>
        </div>
        {/* All case actions live behind one "Actions ▾" menu, matching the client detail header. */}
        <CaseActionsMenu
          caseId={c.id}
          action={c.action}
          started={started}
          paused={paused}
          canSchedule={!["completed", "failed"].includes(c.status)}
          scheduledForIso={scheduledForIso}
          effectiveDate={effectiveDate}
          showHardMatch={showHardMatch}
          hasInitialPassword={hasInitialPassword}
          resetSourceJobId={resetSourceJobId}
          resetSourceSystemName={resetSourceJob?.systemName ?? null}
          canResetPassword={canRevealPassword}
          domain={domainInfo}
        />
      </div>
      {paused && (
        <p className="note" style={{ color: "#8a6d00" }}>
          ⏸ This case is paused — runners won&rsquo;t claim its steps until you resume (a step already running finishes normally).
          {scheduledForIso && <> It resumes automatically at <LocalDateTime iso={scheduledForIso} />.</>}
        </p>
      )}

      {changePreviewDiffs && <ChangePreview caseId={c.id} diffs={changePreviewDiffs} />}

      {/* Dry run is no longer offered as an option (WhatIf suppresses cmdlet output, producing
          false failures like unset $userId). We still surface an exit path for any case already
          in dry-run so it can be re-run for real. */}
      {c.dryRun && (
        <div style={{ margin: "0.5rem 0 1rem", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span className="badge" style={{ color: "var(--info-fg)", borderColor: "var(--info-bg)", background: "var(--info-bg)" }}>
            dry run · no changes made
          </span>
          <ExitDryRunButton caseId={c.id} />
        </div>
      )}

      {playbook && playbook.steps.length > 0 && (
        <CollapsibleSection title="Playbook (dry run)" count={playbook.steps.length}>
          <PlaybookView playbook={playbook} caseId={c.id} />
        </CollapsibleSection>
      )}

      <CollapsibleSection title="Credentials">
        <CaseSecretsPanel caseId={c.id} />
      </CollapsibleSection>

      {runReport && runReport.steps.length > 0 && (
        <CollapsibleSection title="Run report" count={runReport.steps.length}>
          <RunReportView initial={runReport} caseId={c.id} writeEnabled={writeEnabled} />
        </CollapsibleSection>
      )}

      <CollapsibleSection title="Planned steps" count={c.jobs.length}>
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
      </CollapsibleSection>

      {manual.length > 0 && (
        <CollapsibleSection title="Manual checklist" count={manual.length}>
          <ul className="note">
            {manual.map((j) => <li key={j.id}>{j.systemName} — {j.mode}</li>)}
          </ul>
        </CollapsibleSection>
      )}

      {c.serviceNowCaseNumber && (
        <CollapsibleSection title={`Intake form (${c.serviceNowCaseNumber})`}>
          <p className="note">Live from ServiceNow — what the requester filled in, and what they left blank.</p>
          <IntakePanel caseId={c.id} />
        </CollapsibleSection>
      )}

      <CollapsibleSection title="Intake details" subtitle="The fields from the ServiceNow request that drive this case's plan.">
      {c.serviceNowCaseNumber && (
        <div style={{ margin: "0 0 0.6rem" }}>
          <RescanButton caseId={c.id} caseNumber={c.serviceNowCaseNumber} />
        </div>
      )}
      <table>
        <tbody>
          {Object.entries(c.payload)
            .filter(([k]) => !k.startsWith("__") && k !== "requestedByContactSysId" && k !== "openedBySysId")
            .map(([k, v]) => (
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
      </CollapsibleSection>
      <p className="note" style={{ marginTop: "1rem" }}>
        {automated.length} automated, {manual.length} manual. Review the playbook before dispatch; the run report tracks execution.
      </p>
    </main>
  );
}
