// Agents (runners) — list + enroll + enable/disable + trash. Server component reads Prisma directly.
import { db } from "@/lib/db";
import { makeRunnerService } from "@/lib/jobs/runner-service";
import { currentClientScope, clientIdWhere } from "@/lib/auth/client-scope";
import { trashDaysLeft } from "@/lib/jobs/agent-trash";
import { runnerBuildId, runnerVersion } from "@/lib/runner/bundle";
import { AgentsView, type AgentVM, type TrashedAgentVM } from "./_components/agents-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agents" };

export default async function AgentsPage() {
  // Purge any trash past the 30-day window on load (no cron infra — lazy purge on visit).
  await makeRunnerService(db).purgeExpiredTrash();

  // Scope-gate to the operator's visible clients, BUT the shared central runner (clientId null) is
  // infrastructure that serves every client — it stays visible to everyone (its pending-jobs hints
  // below are still scoped, so a hidden client's subjects don't leak). A client-network agent shows
  // only to operators who can see that client. super_admin / auth-off (scope null) sees all.
  const scope = await currentClientScope(db);
  const agentScopeWhere = scope === null ? {} : { OR: [{ clientId: null }, { clientId: { in: scope } }] };
  const agents = await db.agent.findMany({
    where: { deletedAt: null, ...agentScopeWhere },
    orderBy: { name: "asc" },
    include: { client: { select: { slug: true, name: true } }, _count: { select: { jobs: true } } },
  });
  const trashed = await db.agent.findMany({
    where: { deletedAt: { not: null }, ...agentScopeWhere },
    orderBy: { deletedAt: "desc" },
    include: { client: { select: { name: true } } },
  });
  const clients = await db.client.findMany({
    where: { status: "active", id: clientIdWhere(scope) },
    orderBy: { name: "asc" },
    select: { slug: true, name: true },
  });

  // Active (pending/in-flight) api jobs, to show per agent on hover: what each runner is doing or
  // about to do. A job is relevant to an agent if it's assigned to it (in flight) OR it's pending and
  // in the agent's claim scope (central sees all; a client agent sees only its client's).
  const activeJobs = await db.job.findMany({
    where: { mode: "api", status: { in: ["pending", "dispatched", "running"] }, case: { deletedAt: null, status: { notIn: ["failed", "completed"] }, clientId: clientIdWhere(scope) } },
    orderBy: [{ caseRequestId: "asc" }, { sequence: "asc" }],
    select: { status: true, systemKey: true, assignedAgentId: true, case: { select: { clientId: true, subject: true, action: true } } },
  });
  const jobsForAgent = (id: string, clientId: string | null) =>
    activeJobs
      .filter((j) => j.assignedAgentId === id || (j.status === "pending" && (clientId === null || j.case.clientId === clientId)))
      .slice(0, 30)
      .map((j) => ({ systemKey: j.systemKey, subject: j.case.subject, action: j.case.action, status: j.status }));

  const vms: AgentVM[] = agents.map((a) => ({
    id: a.id,
    name: a.name,
    scope: a.scope,
    clientSlug: a.client?.slug ?? null,
    clientName: a.client?.name ?? null,
    version: a.version,
    semver: a.semver,
    enabled: a.enabled,
    lastSeenAt: a.lastSeenAt?.toISOString() ?? null,
    jobCount: a._count.jobs,
    // Only an enabled agent can claim — don't imply pending work on a disabled/down one.
    pendingJobs: a.enabled ? jobsForAgent(a.id, a.clientId) : [],
    updateRequested: a.updateRequested,
    updateRequestedAt: a.updateRequestedAt?.toISOString() ?? null,
    updateRequestedBy: a.updateRequestedBy ?? null,
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
      <AgentsView agents={vms} clients={clients} trashed={trashVms} currentBuild={runnerBuildId()} currentVersion={runnerVersion()} now={Date.now()} />
    </main>
  );
}
