// Agents v2 (reached via the Version 2 toggle): identical data to /agents, but the view is denser —
// priority sits under the runner name, scope+client fold into the identity cell, and every per-agent
// action lives behind one "Actions ▾" menu instead of an always-visible button grid.
import { db } from "@/lib/db";
import { makeRunnerService } from "@/lib/jobs/runner-service";
import { currentClientScope, clientIdWhere } from "@/lib/auth/client-scope";
import { trashDaysLeft } from "@/lib/jobs/agent-trash";
import { runnerBuildId, runnerVersion } from "@/lib/runner/bundle";
import { AgentsView, type AgentVM, type TrashedAgentVM } from "../_components/agents-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agents (v2)" };

export default async function AgentsV2Page() {
  await makeRunnerService(db).purgeExpiredTrash();

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

  const activeJobs = await db.job.findMany({
    where: { mode: "api", status: { in: ["pending", "dispatched", "running"] }, case: { deletedAt: null, status: { notIn: ["failed", "completed"] }, clientId: clientIdWhere(scope) } },
    orderBy: [{ caseRequestId: "asc" }, { sequence: "asc" }],
    select: { status: true, systemKey: true, assignedAgentId: true, startedAt: true, progress: true, case: { select: { clientId: true, subject: true, action: true, serviceNowCaseNumber: true } } },
  });
  const jobsForAgent = (id: string, clientId: string | null) =>
    activeJobs
      .filter((j) => j.assignedAgentId === id || (j.status === "pending" && (clientId === null || j.case.clientId === clientId)))
      .slice(0, 30)
      .map((j) => ({ systemKey: j.systemKey, caseNumber: j.case.serviceNowCaseNumber, subject: j.case.subject, action: j.case.action, status: j.status }));

  const activeStateForAgent = (id: string): { phase: string | null; sinceIso: string | null } => {
    const inflight = activeJobs.filter((j) => j.assignedAgentId === id && (j.status === "dispatched" || j.status === "running"));
    let best: { ts: number; phase: string | null } | null = null;
    for (const j of inflight) {
      const prog = Array.isArray(j.progress) ? (j.progress as { ts?: string; phase?: string }[]) : [];
      const last = prog.length ? prog[prog.length - 1] : null;
      const ts = last?.ts ? Date.parse(last.ts) : j.startedAt ? j.startedAt.getTime() : NaN;
      if (!Number.isNaN(ts) && (best === null || ts > best.ts)) best = { ts, phase: last?.phase ?? null };
    }
    return best ? { phase: best.phase, sinceIso: new Date(best.ts).toISOString() } : { phase: null, sinceIso: null };
  };

  const vms: AgentVM[] = agents.map((a) => {
    const active = a.enabled ? activeStateForAgent(a.id) : { phase: null, sinceIso: null };
    return {
      id: a.id,
      name: a.name,
      scope: a.scope,
      clientSlug: a.client?.slug ?? null,
      clientName: a.client?.name ?? null,
      version: a.version,
      semver: a.semver,
      priority: a.priority ?? 100,
      enabled: a.enabled,
      lastSeenAt: a.lastSeenAt?.toISOString() ?? null,
      bootAt: a.bootAt?.toISOString() ?? null,
      jobCount: a._count.jobs,
      pendingJobs: a.enabled ? jobsForAgent(a.id, a.clientId) : [],
      activePhase: active.phase,
      activeSinceIso: active.sinceIso,
      updateRequested: a.updateRequested,
      updateRequestedAt: a.updateRequestedAt?.toISOString() ?? null,
      updateRequestedBy: a.updateRequestedBy ?? null,
      updateDeliveredAt: a.updateDeliveredAt?.toISOString() ?? null,
      restartRequested: a.restartRequested,
    };
  });
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
      <AgentsView agents={vms} clients={clients} trashed={trashVms} currentBuild={runnerBuildId()} currentVersion={runnerVersion()} now={Date.now()} v2 />
    </main>
  );
}
