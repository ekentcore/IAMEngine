// RUN REPORT: after-action aggregation of a case — per-step status (verified / warning /
// failed), the actions each module took, the validation read-backs, and any errors — plus a
// summary. A "warning" is a job that succeeded but whose validation missed (ok=false); warnings
// never fail the case (deriveCaseStatus is unchanged). Always available on-screen + as markdown.
//
// Pure core (buildRunReport) takes already-loaded rows so it's unit-testable without a DB; the
// DB loader (loadRunReport) gathers the inputs and a markdown renderer produces the export.
import type { PrismaClient } from "@prisma/client";

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
    const phaseTrail = phaseTrailOf(j.progress);
    // Only show a "current phase" while the step is actually in flight — a finished step's last
    // phase isn't what it's "doing now".
    const inFlight = j.status === "running" || j.status === "dispatched";
    const currentPhase = inFlight && phaseTrail.length ? phaseTrail[phaseTrail.length - 1].phase : null;

    return {
      seq: i + 1,
      jobId: j.id,
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
      client: { select: { name: true, slug: true } },
      jobs: { orderBy: { sequence: "asc" }, select: { id: true, systemKey: true, sequence: true, mode: true, status: true, request: true, result: true, validation: true, progress: true, error: true, startedAt: true, finishedAt: true } },
    },
  });
  if (!c) return null;

  const keys = [...new Set(c.jobs.map((j) => j.systemKey))];
  const catalog = await db.systemCatalog.findMany({ where: { key: { in: keys } }, select: { key: true, name: true } });
  const names = new Map(catalog.map((sc) => [sc.key, sc.name]));

  return buildRunReport({
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
}
