// RUN REPORT: after-action aggregation of a case — per-step status (verified / warning /
// failed), the actions each module took, the validation read-backs, and any errors — plus a
// summary. A "warning" is a job that succeeded but whose validation missed (ok=false); warnings
// never fail the case (deriveCaseStatus is unchanged). Always available on-screen + as markdown.
//
// Pure core (buildRunReport) takes already-loaded rows so it's unit-testable without a DB; the
// DB loader (loadRunReport) gathers the inputs and a markdown renderer produces the export.
import type { PrismaClient } from "@prisma/client";
import { missingRequiredSecrets } from "./case-secrets";
import { ON_PREM_SYSTEMS } from "../jobs/runner-service";

export type StepVerdict = "verified" | "warning" | "failed" | "skipped" | "manual" | "needs_approval" | "pending";

export type RunReportStep = {
  seq: number;
  jobId?: string; // for the per-step re-run action
  systemKey: string;
  systemName: string;
  status: string; // raw JobStatus
  verdict: StepVerdict;
  actions: string[];
  validation: { ok: boolean; checks: { name: string; expected?: unknown; actual?: unknown; pass: boolean }[] } | null;
  error: string | null;
  finishedAt: string | null;
  currentPhase: string | null; // what the runner is doing right now (in-flight steps only)
  phaseTrail: { ts: string; phase: string }[]; // the phases this step has gone through
  manualCompleted: boolean; // marked done by an operator (a manual/skipped step closed by hand)
  // Procurement-case watch on this step (license blocked on seats): when the PC resolves in SN the
  // job auto-re-queues. null = no watch.
  procurement: { number: string; state: string; note: string | null; lastCheckedAt: string | null } | null;
  // Self-scheduled retry (request.autoRetry): the step is waiting for a vendor-side sync (e.g.
  // Spanning discovering a new M365 user) and re-runs itself when `at` arrives. null = none.
  autoRetry: { at: string; count: number; firstAt: string } | null;
  // For a step sitting at "pending": WHY it hasn't started — waiting on predecessors, a missing
  // credential, or no runner online. The ordering part is computed here; loadRunReport refines the
  // "ready" case with credential/runner checks. null when the step isn't pending.
  pendingReason: string | null;
};

export type RunReport = {
  caseId: string;
  caseNumber: string | null;
  subject: string | null;
  action: string;
  client: { name: string; slug: string };
  caseStatus: string;
  verifiedAt: string | null; // when the auto-verify sweep completed (null until verified)
  verifying: boolean; // a validate-only sweep is in flight right now (persistent across step gaps)
  user: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  steps: RunReportStep[];
  summary: { succeeded: number; warnings: number; failed: number; skipped: number; manual: number; needsApproval: number; pending: number };
};

type JobRow = {
  procurementWatch?: { number: string; state: string; note: string | null; lastCheckedAt: Date | null } | null;
  id?: string;
  systemKey: string;
  sequence: number;
  mode: string;
  status: string;
  request: unknown;
  result: unknown;
  validation: unknown;
  progress?: unknown;
  error: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
};

export type BuildRunReportInput = {
  caseId: string;
  caseNumber: string | null;
  subject: string | null;
  action: string;
  caseStatus: string;
  verifiedAt?: string | null;
  client: { name: string; slug: string };
  payload: Record<string, unknown>;
  jobs: JobRow[];
  names: Map<string, string>;
};

// Pull the human-readable action lines out of a module result envelope ({ Actions: [...] } —
// PowerShell PascalCase; tolerate camelCase too).
function actionsOf(result: unknown): string[] {
  if (!result || typeof result !== "object") return [];
  const r = result as Record<string, unknown>;
  const a = r.Actions ?? r.actions;
  return Array.isArray(a) ? a.map(String) : [];
}

function normalizeValidation(v: unknown): RunReportStep["validation"] {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const ok = o.ok ?? o.Ok ?? o.OK;
  const checksRaw = o.checks ?? o.Checks;
  const checks = Array.isArray(checksRaw)
    ? checksRaw.map((c) => {
        const cc = (c ?? {}) as Record<string, unknown>;
        return { name: String(cc.name ?? cc.Name ?? ""), expected: cc.expected ?? cc.Expected, actual: cc.actual ?? cc.Actual, pass: Boolean(cc.pass ?? cc.Pass) };
      })
    : [];
  return { ok: Boolean(ok), checks };
}

// The warning lines a single (succeeded) job contributes: its WARN-tagged actions plus any failed
// validation checks. Shared with the cases list so a "completed" case can show orange + the
// warnings on hover, with exactly the same definition of "warning" as the run report.
export function jobWarningLines(result: unknown, validation: unknown): string[] {
  const lines = actionsOf(result).filter((a) => /\bWARN\b/i.test(a));
  const v = normalizeValidation(validation);
  if (v && !v.ok) {
    const missed = v.checks.filter((c) => !c.pass).map((c) => c.name).filter(Boolean);
    lines.push(missed.length ? `validation missed: ${missed.join(", ")}` : "validation missed");
  }
  return lines;
}

function phaseTrailOf(progress: unknown): { ts: string; phase: string }[] {
  if (!Array.isArray(progress)) return [];
  return progress
    .map((p) => (p && typeof p === "object" ? (p as Record<string, unknown>) : {}))
    .filter((p) => typeof p.phase === "string")
    .map((p) => ({ ts: String(p.ts ?? ""), phase: String(p.phase) }));
}

function verdictOf(status: string, validation: RunReportStep["validation"]): StepVerdict {
  switch (status) {
    case "succeeded":
      return validation && !validation.ok ? "warning" : "verified";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    case "manual":
      return "manual";
    default:
      return "pending"; // pending | dispatched | running
  }
}

function userHeader(action: string, payload: Record<string, unknown>): string | null {
  const u =
    action === "offboard"
      ? payload.userToOffboard ?? payload.userPrincipalName ?? payload.workEmail
      : payload.userPrincipalName ?? payload.workEmail ?? payload.displayName;
  return u ? String(u) : null;
}

export function buildRunReport(input: BuildRunReportInput): RunReport {
  const jobs = [...input.jobs].sort((a, b) => a.sequence - b.sequence);
  const summary = { succeeded: 0, warnings: 0, failed: 0, skipped: 0, manual: 0, needsApproval: 0, pending: 0 };

  const steps: RunReportStep[] = jobs.map((j, i) => {
    const validation = normalizeValidation(j.validation);
    const req = (j.request ?? {}) as { requiresApproval?: boolean; approved?: boolean };
    let verdict = verdictOf(j.status, validation);
    // A pending approval-gated job is surfaced distinctly from an ordinary pending step.
    if (verdict === "pending" && req.requiresApproval && !req.approved) verdict = "needs_approval";
    // A step that succeeded but logged a WARN action (e.g. a group/license it couldn't apply) is a
    // warning, not a clean "verified" — surface it even when the validation read-back passed.
    // Match WARN anywhere in the action, not just the start — actions are often prefixed
    // ("license: WARN could not add to E5 group"), which a start-anchored match would miss.
    const stepActions = actionsOf(j.result);
    if (verdict === "verified" && stepActions.some((a) => /\bWARN\b/i.test(a))) verdict = "warning";

    if (verdict === "verified") summary.succeeded++;
    else if (verdict === "warning") summary.warnings++;
    else if (verdict === "failed") summary.failed++;
    else if (verdict === "skipped") summary.skipped++;
    else if (verdict === "manual") summary.manual++;
    else if (verdict === "needs_approval") summary.needsApproval++;
    else summary.pending++;

    const manualCompleted = Boolean((j.result as Record<string, unknown> | null)?.manualCompletion);
    // Why is a pending api step not running yet? Same gating rule as the runner's claim
    // (blockingJobs): a job with persisted dependsOn waits ONLY on those systems; legacy jobs
    // (planned before deps were persisted) wait on every earlier api job.
    let pendingReason: string | null = null;
    if (j.status === "pending" && j.mode === "api" && verdict === "pending") {
      const deps = ((j.request ?? {}) as { dependsOn?: unknown }).dependsOn;
      const unmetBlocker = (o: JobRow) => o.mode === "api" && o.status !== "succeeded" && o.status !== "skipped";
      const blockers = Array.isArray(deps)
        ? jobs.filter((o) => unmetBlocker(o) && (deps as unknown[]).includes(o.systemKey))
        : jobs.filter((o) => unmetBlocker(o) && o.sequence < j.sequence);
      pendingReason = blockers.length
        ? `waiting for ${blockers.map((b) => input.names.get(b.systemKey) ?? b.systemKey).join(", ")} to finish first`
        : "ready — waiting for a runner to claim it";
    }
    const phaseTrail = phaseTrailOf(j.progress);
    // Only show a "current phase" while the step is actually in flight — a finished step's last
    // phase isn't what it's "doing now".
    const inFlight = j.status === "running" || j.status === "dispatched";
    const currentPhase = inFlight && phaseTrail.length ? phaseTrail[phaseTrail.length - 1].phase : null;

    return {
      seq: i + 1,
      jobId: j.id,
      procurement: j.procurementWatch
        ? { number: j.procurementWatch.number, state: j.procurementWatch.state, note: j.procurementWatch.note ?? null, lastCheckedAt: j.procurementWatch.lastCheckedAt ? new Date(j.procurementWatch.lastCheckedAt).toISOString() : null }
        : null,
      systemKey: j.systemKey,
      systemName: input.names.get(j.systemKey) ?? j.systemKey,
      status: j.status,
      verdict,
      actions: actionsOf(j.result),
      validation,
      error: j.error,
      finishedAt: j.finishedAt ? j.finishedAt.toISOString() : null,
      currentPhase,
      phaseTrail,
      manualCompleted,
      pendingReason,
      autoRetry: (() => {
        const ar = ((j.request ?? {}) as { autoRetry?: { at?: number; count?: number; firstAt?: number } }).autoRetry;
        return ar?.at ? { at: new Date(ar.at).toISOString(), count: ar.count ?? 1, firstAt: new Date(ar.firstAt ?? ar.at).toISOString() } : null;
      })(),
    };
  });

  const times = jobs.map((j) => j.startedAt).filter(Boolean) as Date[];
  const ends = jobs.map((j) => j.finishedAt).filter(Boolean) as Date[];
  return {
    caseId: input.caseId,
    caseNumber: input.caseNumber,
    subject: input.subject,
    action: input.action,
    client: input.client,
    caseStatus: input.caseStatus,
    verifiedAt: input.verifiedAt ?? null,
    // A sweep is in flight when a validate-only job is still pending/dispatched/running.
    verifying: input.jobs.some((j) => Boolean((j.request as { validateOnly?: boolean } | null)?.validateOnly) && ["pending", "dispatched", "running"].includes(j.status)),
    user: userHeader(input.action, input.payload),
    startedAt: times.length ? new Date(Math.min(...times.map((d) => d.getTime()))).toISOString() : null,
    finishedAt: ends.length ? new Date(Math.max(...ends.map((d) => d.getTime()))).toISOString() : null,
    steps,
    summary,
  };
}

const VERDICT_LABEL: Record<StepVerdict, string> = {
  verified: "✅ verified",
  warning: "⚠️ warning",
  failed: "❌ failed",
  skipped: "skipped",
  manual: "✋ manual",
  needs_approval: "🔒 needs approval",
  pending: "… pending",
};

export function renderRunReportMarkdown(rr: RunReport): string {
  const out: string[] = [];
  out.push(`# Run report — ${rr.subject ?? rr.caseNumber ?? rr.caseId}`);
  out.push("");
  out.push(`- Client: ${rr.client.name} (${rr.client.slug})`);
  out.push(`- Action: ${rr.action}`);
  if (rr.user) out.push(`- User: ${rr.user}`);
  if (rr.caseNumber) out.push(`- ServiceNow: ${rr.caseNumber}`);
  out.push(`- Case status: ${rr.caseStatus}`);
  const s = rr.summary;
  out.push(`- Summary: ${s.succeeded} verified, ${s.warnings} warning, ${s.failed} failed, ${s.skipped} skipped, ${s.manual} manual, ${s.needsApproval} needs approval, ${s.pending} pending`);
  out.push("");
  for (const step of rr.steps) {
    out.push(`## ${step.seq}. ${step.systemName} (${step.systemKey}) — ${VERDICT_LABEL[step.verdict]}`);
    if (step.actions.length) {
      out.push("");
      out.push("Actions:");
      for (const a of step.actions) out.push(`- ${a}`);
    }
    if (step.validation) {
      out.push("");
      out.push(`Validation: ${step.validation.ok ? "ok" : "MISS"}`);
      for (const c of step.validation.checks) out.push(`- ${c.pass ? "✓" : "✗"} ${c.name}${c.expected !== undefined ? ` (expected ${String(c.expected)}, got ${String(c.actual)})` : ""}`);
    }
    if (step.error) {
      out.push("");
      out.push(`Error: ${step.error}`);
    }
    out.push("");
  }
  return out.join("\n");
}

export async function loadRunReport(db: PrismaClient, caseId: string): Promise<RunReport | null> {
  const c = await db.caseRequest.findUnique({
    where: { id: caseId },
    include: {
      client: { select: { id: true, name: true, slug: true } },
      jobs: { orderBy: { sequence: "asc" }, select: { id: true, systemKey: true, sequence: true, mode: true, status: true, request: true, result: true, validation: true, progress: true, error: true, startedAt: true, finishedAt: true, procurementWatch: { select: { number: true, state: true, note: true, lastCheckedAt: true } } } },
    },
  });
  if (!c) return null;

  const keys = [...new Set(c.jobs.map((j) => j.systemKey))];
  const catalog = await db.systemCatalog.findMany({ where: { key: { in: keys } }, select: { key: true, name: true } });
  const names = new Map(catalog.map((sc) => [sc.key, sc.name]));

  const report = buildRunReport({
    caseId: c.id,
    caseNumber: c.serviceNowCaseNumber,
    subject: c.subject,
    action: c.action,
    caseStatus: c.status,
    verifiedAt: c.verifiedAt ? c.verifiedAt.toISOString() : null,
    client: c.client,
    payload: (c.payload ?? {}) as Record<string, unknown>,
    jobs: c.jobs,
    names,
  });

  // An operator-paused case: every pending step is held by the pause, whatever else is true.
  if (c.pausedAt) {
    for (const st of report.steps) {
      if (st.pendingReason) st.pendingReason = "case is paused — resume it to dispatch this step";
    }
    return report;
  }

  // Refine the "ready — waiting for a runner" pending steps with the two REAL blockers the
  // ordering rule can't see: an unset required credential (the claim preflight skips the job) and
  // no runner being online to claim it. This is the on-page answer to "it's just sitting at
  // pending with no feedback".
  const ready = report.steps.filter((st) => st.pendingReason === "ready — waiting for a runner to claim it");
  if (ready.length > 0) {
    const [clientSecrets, onlineAgents] = await Promise.all([
      db.secret.findMany({ where: { clientId: c.client.id }, select: { name: true, externalId: true } }),
      db.agent.findMany({
        where: { enabled: true, deletedAt: null, lastSeenAt: { gt: new Date(Date.now() - 90_000) } },
        select: { clientId: true, name: true, lastSeenAt: true },
      }),
    ]);
    const byName = new Map<string, string | null>(clientSecrets.map((sx) => [sx.name, sx.externalId]));
    for (const st of ready) {
      const job = c.jobs.find((j) => j.id === st.jobId);
      const needed = ((job?.request ?? {}) as { secretNames?: string[] }).secretNames ?? [];
      // Same preflight rule the claim loop uses (case override > client default, REPLACE_ME = unset).
      const missing = missingRequiredSecrets(needed, c.secretOverrides, byName);
      if (missing.length) {
        st.pendingReason = `blocked — credential not set: ${missing.join(", ")}. Fill it on the Credentials panel; the runner skips this step until it resolves.`;
        continue;
      }
      // Host affinity, same rule as the claim filter: on-prem systems (AD/Exchange/dir-sync) are
      // ONLY claimed by the client's own agent — a central runner being online doesn't help them.
      const needsOnPrem = ON_PREM_SYSTEMS.includes(st.systemKey);
      const eligible = onlineAgents.filter((a) => (needsOnPrem ? a.clientId === c.client.id : a.clientId === null || a.clientId === c.client.id));
      if (eligible.length === 0) {
        st.pendingReason = needsOnPrem
          ? "ready, but this step runs on the client's ON-PREM agent and none is online — check the Agents page"
          : "ready, but no runner is online to claim it — check the Agents page";
        continue;
      }
      // Pull model: the runner claims on its next poll (~15s). Name it + show how fresh it is, so
      // "ready" reads as "about to start" instead of "stuck".
      const best = [...eligible].sort((x, y) => new Date(y.lastSeenAt ?? 0).getTime() - new Date(x.lastSeenAt ?? 0).getTime())[0];
      const secs = Math.max(0, Math.round((Date.now() - new Date(best.lastSeenAt ?? 0).getTime()) / 1000));
      st.pendingReason = `ready — ${best.name} claims it on its next poll (~15s; last polled ${secs}s ago)`;
    }
  }
  return report;
}
