// Agents (runners) — list + enroll + enable/disable + trash. Server component reads Prisma directly.
import { db } from "@/lib/db";
import { makeRunnerService } from "@/lib/jobs/runner-service";
import { trashDaysLeft } from "@/lib/jobs/agent-trash";
import { AgentsView, type AgentVM, type TrashedAgentVM } from "./_components/agents-view";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  // Purge any trash past the 30-day window on load (no cron infra — lazy purge on visit).
  await makeRunnerService(db).purgeExpiredTrash();

  const agents = await db.agent.findMany({
    where: { deletedAt: null },
    orderBy: { name: "asc" },
    include: { client: { select: { slug: true, name: true } }, _count: { select: { jobs: true } } },
  });
  const trashed = await db.agent.findMany({
    where: { deletedAt: { not: null } },
    orderBy: { deletedAt: "desc" },
    include: { client: { select: { name: true } } },
  });
  const clients = await db.client.findMany({
    where: { status: "active" },
    orderBy: { name: "asc" },
    select: { slug: true, name: true },
  });

  const vms: AgentVM[] = agents.map((a) => ({
    id: a.id,
    name: a.name,
    scope: a.scope,
    clientSlug: a.client?.slug ?? null,
    clientName: a.client?.name ?? null,
    version: a.version,
    enabled: a.enabled,
    lastSeenAt: a.lastSeenAt?.toISOString() ?? null,
    jobCount: a._count.jobs,
    updateRequested: a.updateRequested,
    updateRequestedAt: a.updateRequestedAt?.toISOString() ?? null,
    updateDeliveredAt: a.updateDeliveredAt?.toISOString() ?? null,
  }));
  const now = new Date();
  const trashVms: TrashedAgentVM[] = trashed.map((a) => ({
    id: a.id,
    name: a.name,
    scope: a.scope,
    clientName: a.client?.name ?? null,
    deletedAt: a.deletedAt!.toISOString(),
    daysLeft: trashDaysLeft(a.deletedAt!, now),
  }));

  return (
    <main>
      <div className="row-between">
        <div>
          <h1>Agents</h1>
          <p className="note">
            {vms.length} runner{vms.length === 1 ? "" : "s"} · enroll one, then start it with
            {" "}<code>runner/Start-IamRunner.ps1</code> using its id.
          </p>
        </div>
      </div>
      <AgentsView agents={vms} clients={clients} trashed={trashVms} />
    </main>
  );
}
