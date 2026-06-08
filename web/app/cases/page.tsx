// Cases list (server component).
import { db } from "@/lib/db";
import { makeCaseRepository } from "@/lib/cases/repository";
import { purgeCutoff, trashDaysLeft } from "@/lib/jobs/agent-trash";
import { CasesToolbar } from "./_components/cases-toolbar";
import { CasesTable } from "./_components/cases-table";

export const dynamic = "force-dynamic";

export default async function CasesPage() {
  const repo = makeCaseRepository(db);
  // Purge cases that have sat in the trash past the retention window (mirrors the agents page).
  await repo.purgeExpiredTrashedCases(purgeCutoff(new Date()));

  // Clients for the "new case" picker (slug + name only).
  const [cases, trashed, clients] = await Promise.all([
    repo.listCases(),
    repo.listTrashedCases(),
    db.client.findMany({
      where: { status: "active" },
      orderBy: { name: "asc" },
      select: { slug: true, name: true },
    }),
  ]);

  // Date isn't safe to hand a client component as-is — send an ISO string the table sorts on.
  const rows = cases.map((c) => ({
    id: c.id,
    action: c.action,
    status: c.status,
    subject: c.subject,
    serviceNowCaseNumber: c.serviceNowCaseNumber,
    clientName: c.clientName,
    jobCount: c.jobCount,
    statusHint: c.statusHint,
    effectiveDate: c.effectiveDate,
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

  return (
    <main>
      <div className="row-between">
        <div>
          <h1>Cases</h1>
          <p className="note">{cases.length} cases · onboarding / offboarding requests</p>
        </div>
      </div>

      <CasesToolbar clients={clients} />

      <CasesTable cases={rows} trashed={trashedRows} />
    </main>
  );
}
