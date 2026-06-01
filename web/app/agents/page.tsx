// Agents (runners) — list + enroll + enable/disable. Server component reads Prisma directly.
import { db } from "@/lib/db";
import { AgentsView, type AgentVM } from "./_components/agents-view";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  const agents = await db.agent.findMany({
    orderBy: { name: "asc" },
    include: { client: { select: { slug: true, name: true } }, _count: { select: { jobs: true } } },
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
      <AgentsView agents={vms} clients={clients} />
    </main>
  );
}
