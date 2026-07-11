// Shared page-data loader for /cases and /cases/v2. Both variants render the SAME data —
// only presentation differs — so the queries and row view-models live here once. Adding a
// field here reaches both pages; adding it in a page file is the drift that broke the
// "imported" badge on v2.
import { db } from "@/lib/db";
import { makeCaseRepository } from "@/lib/cases/repository";
import { currentClientScope, clientIdWhere } from "@/lib/auth/client-scope";
import { purgeCutoff, trashDaysLeft } from "@/lib/jobs/agent-trash";

export type CaseRow = Awaited<ReturnType<typeof loadCasesPage>>["rows"][number];

export async function loadCasesPage() {
  const repo = makeCaseRepository(db);
  // Purge cases that have sat in the trash past the retention window (mirrors the agents page).
  await repo.purgeExpiredTrashedCases(purgeCutoff(new Date()));

  // Scope-gate everything to the operator's visible clients (lists + the "new case" picker).
  const scope = await currentClientScope(db);
  const [cases, trashed, clients] = await Promise.all([
    repo.listCases(scope),
    repo.listTrashedCases(scope),
    db.client.findMany({
      where: { status: "active", id: clientIdWhere(scope) },
      orderBy: { name: "asc" },
      select: { slug: true, name: true },
    }),
  ]);

  // Date isn't safe to hand a client component as-is — send an ISO string the table sorts on.
  const rows = cases.map((c) => ({
    id: c.id,
    action: c.action,
    status: c.status,
    paused: c.paused,
    imported: c.imported,
    pausedBy: c.pausedBy,
    warnings: c.warnings,
    subject: c.subject,
    serviceNowCaseNumber: c.serviceNowCaseNumber,
    clientName: c.clientName,
    jobCount: c.jobCount,
    statusHint: c.statusHint,
    effectiveDate: c.effectiveDate,
    immediate: c.immediate,
    scheduledForIso: c.scheduledFor ? c.scheduledFor.toISOString() : null,
    lastRunIso: c.lastRunAt ? c.lastRunAt.toISOString() : null,
    ranBy: c.ranBy,
    lastActionLabel: c.lastActionLabel,
    lastActionBy: c.lastActionBy,
    readiness: c.readiness,
    readinessMissing: c.readinessMissing,
    createdAtIso: c.createdAt.toISOString(),
  }));

  const now = new Date();
  const trashedRows = trashed.map((c) => ({
    id: c.id,
    subject: c.subject,
    serviceNowCaseNumber: c.serviceNowCaseNumber,
    clientName: c.clientName,
    status: c.status,
    jobCount: c.jobCount,
    deletedAtIso: c.deletedAt.toISOString(),
    daysLeft: trashDaysLeft(c.deletedAt, now),
  }));

  return { rows, trashedRows, clients };
}
