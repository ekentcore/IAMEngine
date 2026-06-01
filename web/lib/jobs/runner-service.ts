// Runner coordination: enrollment, heartbeat, atomic claim, credential broker, result +
// case advance. Factory-style over PrismaClient, mirroring lib/clients/repository.ts.
// Pure decisions live in runner-logic.ts; this layer is the I/O around them.
import type { AgentScope, Prisma, PrismaClient } from "@prisma/client";
import { dependencyGateOpen, deriveCaseStatus, type JobLite } from "./runner-logic";
import { HttpError, type BrokeredCredential, type ResultInput, type RunnerJob } from "./types";

type JobRequest = { config?: unknown; requiresApproval?: boolean; captureEvidence?: boolean; secretNames?: string[] };

const req = (j: { request: unknown }): JobRequest => (j.request ?? {}) as JobRequest;

export function makeRunnerService(db: PrismaClient) {
  return {
    async enroll(input: { name: string; scope: AgentScope; clientSlug?: string | null }): Promise<{ id: string; scope: AgentScope; clientId: string | null }> {
      let clientId: string | null = null;
      if (input.clientSlug) {
        const c = await db.client.findUnique({ where: { slug: input.clientSlug }, select: { id: true } });
        if (!c) throw new HttpError(404, `unknown client ${input.clientSlug}`);
        clientId = c.id;
      }
      if (input.scope === "client_network" && !clientId) {
        throw new HttpError(422, "a client_network agent must be bound to a client");
      }
      const agent = await db.agent.create({
        data: { name: input.name, scope: input.scope, clientId, lastSeenAt: new Date() },
        select: { id: true, scope: true, clientId: true },
      });
      await db.auditLog.create({ data: { actor: "system", action: "agent.enroll", clientId, detail: { agentId: agent.id, scope: agent.scope } } });
      return agent;
    },

    async heartbeat(agentId: string, version?: string | null): Promise<{ ok: true; enabled: boolean }> {
      const agent = await db.agent.findUnique({ where: { id: agentId }, select: { id: true, version: true, enabled: true } });
      if (!agent) throw new HttpError(404, "unknown agent");
      await db.agent.update({ where: { id: agentId }, data: { lastSeenAt: new Date(), version: version ?? agent.version } });
      return { ok: true, enabled: agent.enabled };
    },

    // Atomically claim up to `batchSize` eligible api jobs for this agent.
    async claim(agentId: string, batchSize: number): Promise<RunnerJob[]> {
      const agent = await db.agent.findUnique({ where: { id: agentId }, select: { id: true, clientId: true, enabled: true } });
      if (!agent) throw new HttpError(404, "unknown agent");
      if (!agent.enabled) throw new HttpError(403, "agent disabled");

      // central runner (clientId null) sees all clients' api jobs; a client agent sees only its own.
      const candidates = await db.job.findMany({
        where: { status: "pending", mode: "api", ...(agent.clientId ? { case: { clientId: agent.clientId } } : {}) },
        orderBy: [{ caseRequestId: "asc" }, { sequence: "asc" }],
        select: { id: true, caseRequestId: true, sequence: true, mode: true, status: true, request: true },
      });
      if (candidates.length === 0) return [];

      // load all jobs of the candidate cases once, for the dependency gate
      const caseIds = [...new Set(candidates.map((c) => c.caseRequestId))];
      const caseJobs = await db.job.findMany({
        where: { caseRequestId: { in: caseIds } },
        select: { id: true, caseRequestId: true, sequence: true, mode: true, status: true, request: true },
      });
      const lite = (j: typeof caseJobs[number]): JobLite => ({ id: j.id, sequence: j.sequence, mode: j.mode, status: j.status, requiresApproval: Boolean(req(j).requiresApproval) });
      const byCase = new Map<string, JobLite[]>();
      for (const j of caseJobs) {
        const arr = byCase.get(j.caseRequestId) ?? [];
        arr.push(lite(j));
        byCase.set(j.caseRequestId, arr);
      }

      const eligible: string[] = [];
      for (const c of candidates) {
        if (req(c).requiresApproval) continue; // approval-gated: never auto-dispatched
        if (!dependencyGateOpen(lite(c), byCase.get(c.caseRequestId) ?? [])) continue;
        eligible.push(c.id);
        if (eligible.length >= batchSize) break;
      }
      if (eligible.length === 0) return [];

      // atomic: only rows still pending flip; a racing agent's updateMany skips already-claimed rows
      await db.job.updateMany({
        where: { id: { in: eligible }, status: "pending" },
        data: { status: "dispatched", assignedAgentId: agent.id, startedAt: new Date() },
      });
      const claimed = await db.job.findMany({
        where: { id: { in: eligible }, assignedAgentId: agent.id, status: "dispatched" },
        include: { case: { include: { client: { select: { slug: true, primaryDomain: true, backbone: true } } } } },
        orderBy: { sequence: "asc" },
      });
      await db.auditLog.create({ data: { actor: `agent:${agent.id}`, action: "job.claim", detail: { count: claimed.length, jobIds: claimed.map((c) => c.id) } } });

      return claimed.map((j) => {
        const r = req(j);
        return {
          id: j.id,
          action: j.case.action,
          systemKey: j.systemKey,
          mode: j.mode,
          client: { slug: j.case.client.slug, primaryDomain: j.case.client.primaryDomain, backbone: j.case.client.backbone },
          config: r.config ?? null,
          secretNames: r.secretNames ?? [],
          payload: j.case.payload,
          requiresApproval: Boolean(r.requiresApproval),
          captureEvidence: Boolean(r.captureEvidence),
        };
      });
    },

    // Broker a Delinea credential for a job. Least-privilege: the agent must own the job and
    // the secret must be one named on that job. Never returns a secret value (we store only
    // the Delinea reference); production exchanges externalId for a short-TTL scoped cred here.
    async brokerCredential(jobId: string, agentId: string, secretName: string): Promise<BrokeredCredential> {
      const job = await db.job.findUnique({ where: { id: jobId }, select: { assignedAgentId: true, request: true, case: { select: { clientId: true } } } });
      if (!job) throw new HttpError(404, "unknown job");
      if (job.assignedAgentId !== agentId) throw new HttpError(403, "job not assigned to this agent");
      const allowed = req(job).secretNames ?? [];
      if (!allowed.includes(secretName)) throw new HttpError(403, `secret ${secretName} is not authorized for this job`);
      const secret = await db.secret.findUnique({ where: { clientId_name: { clientId: job.case.clientId, name: secretName } }, select: { provider: true, externalId: true } });
      if (!secret) throw new HttpError(404, `no secret reference '${secretName}' for this client`);
      await db.auditLog.create({ data: { actor: `agent:${agentId}`, action: "job.credential", jobId, clientId: job.case.clientId, detail: { secretName } } });
      return { provider: secret.provider, externalId: secret.externalId, secretName, brokered: false, expiresInSeconds: 300, note: "Delinea broker not wired — reference only; exchange externalId for a scoped credential in production" };
    },

    // Record a job result, advance the case, audit, and queue a work note.
    async recordResult(jobId: string, input: ResultInput): Promise<{ jobId: string; status: string; caseStatus: string }> {
      const job = await db.job.findUnique({ where: { id: jobId }, select: { status: true, caseRequestId: true, systemKey: true, assignedAgentId: true, case: { select: { clientId: true, serviceNowCaseNumber: true } } } });
      if (!job) throw new HttpError(404, "unknown job");
      if (job.status !== "dispatched" && job.status !== "running") throw new HttpError(409, `job is ${job.status}, not in progress`);

      const status = input.status === "succeeded" ? "succeeded" : input.status === "skipped" ? "skipped" : "failed";
      await db.job.update({
        where: { id: jobId },
        data: { status, result: (input.result ?? undefined) as Prisma.InputJsonValue | undefined, evidence: (input.evidence ?? undefined) as Prisma.InputJsonValue | undefined, error: input.error ?? null, finishedAt: new Date() },
      });

      const caseJobs = await db.job.findMany({ where: { caseRequestId: job.caseRequestId }, select: { id: true, sequence: true, mode: true, status: true, request: true } });
      const caseStatus = deriveCaseStatus(caseJobs.map((j) => ({ id: j.id, sequence: j.sequence, mode: j.mode, status: j.status, requiresApproval: Boolean(req(j).requiresApproval) })));
      await db.caseRequest.update({ where: { id: job.caseRequestId }, data: { status: caseStatus } });

      await db.auditLog.create({ data: { actor: `agent:${job.assignedAgentId ?? "unknown"}`, action: "job.result", jobId, caseRequestId: job.caseRequestId, clientId: job.case.clientId, detail: { status, error: input.error ?? null } } });
      // Work-note write-back (RUNNER_PROTOCOL): queued as an audit row. The actual ServiceNow
      // write needs the UM record sys_id (we hold only the number) — wire in a follow-up.
      await db.auditLog.create({ data: { actor: "system", action: "servicenow.worknote.pending", caseRequestId: job.caseRequestId, detail: { caseNumber: job.case.serviceNowCaseNumber, note: `${job.systemKey}: ${status}${input.error ? ` — ${input.error}` : ""}` } } });

      return { jobId, status, caseStatus };
    },
  };
}

export type RunnerService = ReturnType<typeof makeRunnerService>;
