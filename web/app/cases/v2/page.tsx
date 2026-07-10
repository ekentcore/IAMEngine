// Cases v2 (test page, no nav link): identical to /cases, except completed cases come off the
// working list into their own "Completed cases" table (between the working table and the trash).
// Reach it directly at /cases/v2 so it doesn't disturb people working on /cases.
import Link from "next/link";
import { db } from "@/lib/db";
import { makeCaseRepository } from "@/lib/cases/repository";
import { currentClientScope, clientIdWhere } from "@/lib/auth/client-scope";
import { purgeCutoff, trashDaysLeft } from "@/lib/jobs/agent-trash";
import { CasesToolbar } from "../_components/cases-toolbar";
import { CasesTable } from "../_components/cases-table";

export const dynamic = "force-dynamic";
export const metadata = { title: "Cases (v2)" };

export default async function CasesV2Page() {
  const repo = makeCaseRepository(db);
  await repo.purgeExpiredTrashedCases(purgeCutoff(new Date()));

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

  const rows = cases.map((c) => ({
    id: c.id,
    action: c.action,
    status: c.status,
    paused: c.paused,
    pausedBy: c.pausedBy,
    warnings: c.warnings,
    subject: c.subject,
    serviceNowCaseNumber: c.serviceNowCaseNumber,
    clientName: c.clientName,
    jobCount: c.jobCount,
    statusHint: c.statusHint,
    effectiveDate: c.effectiveDate,
    immediate: c.immediate,
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

  const open = cases.filter((c) => c.status !== "completed").length;
  const done = cases.length - open;

  return (
    <main>
      <div className="row-between">
        <div>
          <h1>Cases <span className="note">(v2)</span></h1>
          <p className="note">{open} open · {done} completed · completed work is kept in its own table</p>
        </div>
        <Link href="/cases" className="note" style={{ alignSelf: "flex-start" }}>← back to Cases</Link>
      </div>

      <CasesToolbar clients={clients} />

      <CasesTable cases={rows} trashed={trashedRows} splitCompleted />
    </main>
  );
}
