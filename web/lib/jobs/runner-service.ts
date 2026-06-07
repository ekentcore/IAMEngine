// Runner coordination: enrollment, heartbeat, atomic claim, credential broker, result +
// case advance. Factory-style over PrismaClient, mirroring lib/clients/repository.ts.
// Pure decisions live in runner-logic.ts; this layer is the I/O around them.
import type { AgentScope, Prisma, PrismaClient } from "@prisma/client";
import { deriveCaseStatus, isClaimable, type JobLite } from "./runner-logic";
import { HttpError, type BrokeredCredential, type ResultInput, type RunnerJob } from "./types";
import { resolveSecretFields, delineaConfigFromEnv, delineaConfigured } from "../secrets/delinea";
import { effectiveExternalId } from "../cases/case-secrets";
import { purgeCutoff } from "./agent-trash";
import { postWorkNote, writeBackEnabled } from "../servicenow/worknote";
import { snConfigFromEnv } from "../servicenow/gateway";

type JobRequest = { config?: unknown; requiresApproval?: boolean; captureEvidence?: boolean; secretNames?: string[]; approved?: boolean; dryRun?: boolean };

const req = (j: { request: unknown }): JobRequest => (j.request ?? {}) as JobRequest;

// A claimed job whose runner never posts a result is reclaimed after this long (crash/stall).
const LEASE_MS = 10 * 60 * 1000;

// An agent disabled mid-flight must not keep brokering credentials or posting results.
async function assertAgentEnabled(db: PrismaClient, agentId: string): Promise<void> {
  const agent = await db.agent.findUnique({ where: { id: agentId }, select: { enabled: true } });
  if (!agent) throw new HttpError(404, "unknown agent");
  if (!agent.enabled) throw new HttpError(403, "agent disabled");
}

export function makeRunnerService(db: PrismaClient) {
  return {
    async enroll(input: { name: string; scope: AgentScope; clientSlug?: string | null }): Promise<{ id: string; scope: AgentScope; clientId: string | null }> {
      let clientId: string | null = null;
      const slug = input.clientSlug?.trim() || null; // tolerate a stray space in a token's client
      if (slug) {
        const c = await db.client.findUnique({ where: { slug }, select: { id: true } });
        if (!c) throw new HttpError(404, `unknown client ${slug}`);
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

    // Operator action: enable/disable an agent (a disabled agent can't claim/broker/post).
    async setEnabled(agentId: string, enabled: boolean): Promise<{ id: string; enabled: boolean }> {
      const agent = await db.agent.findUnique({ where: { id: agentId }, select: { id: true } });
      if (!agent) throw new HttpError(404, "unknown agent");
      await db.agent.update({ where: { id: agentId }, data: { enabled } });
      await db.auditLog.create({ data: { actor: "ui", action: enabled ? "agent.enable" : "agent.disable", detail: { agentId } } });
      return { id: agentId, enabled };
    },

    // Move a DISABLED agent to the trash (soft delete; restorable for TRASH_RETENTION_DAYS).
    async trashAgent(agentId: string): Promise<{ id: string }> {
      const agent = await db.agent.findUnique({ where: { id: agentId }, select: { id: true, enabled: true, deletedAt: true } });
      if (!agent) throw new HttpError(404, "unknown agent");
      if (agent.enabled) throw new HttpError(409, "disable the runner before moving it to the trash");
      if (agent.deletedAt) return { id: agentId }; // already trashed (idempotent)
      await db.agent.update({ where: { id: agentId }, data: { deletedAt: new Date() } });
      await db.auditLog.create({ data: { actor: "ui", action: "agent.trash", detail: { agentId } } });
      return { id: agentId };
    },

    // Restore a trashed agent — it comes back DISABLED (re-enable explicitly before use).
    async restoreAgent(agentId: string): Promise<{ id: string }> {
      const agent = await db.agent.findUnique({ where: { id: agentId }, select: { id: true } });
      if (!agent) throw new HttpError(404, "unknown agent");
      await db.agent.update({ where: { id: agentId }, data: { deletedAt: null, enabled: false } });
      await db.auditLog.create({ data: { actor: "ui", action: "agent.restore", detail: { agentId } } });
      return { id: agentId };
    },

    // Permanently delete an agent (jobs keep their history; assignedAgentId is set null).
    async deleteAgentForever(agentId: string): Promise<{ id: string }> {
      const agent = await db.agent.findUnique({ where: { id: agentId }, select: { id: true } });
      if (!agent) throw new HttpError(404, "unknown agent");
      await db.auditLog.create({ data: { actor: "ui", action: "agent.delete", detail: { agentId } } });
      await db.agent.delete({ where: { id: agentId } });
      return { id: agentId };
    },

    // Hard-delete trashed agents past the retention window. Returns how many were purged.
    async purgeExpiredTrash(now: Date = new Date()): Promise<number> {
      const res = await db.agent.deleteMany({ where: { deletedAt: { not: null, lte: purgeCutoff(now) } } });
      if (res.count) await db.auditLog.create({ data: { actor: "system", action: "agent.purge", detail: { count: res.count } } });
      return res.count;
    },

    async heartbeat(agentId: string, version?: string | null): Promise<{ ok: true; enabled: boolean; update: boolean; discover: boolean }> {
      const agent = await db.agent.findUnique({ where: { id: agentId }, select: { id: true, version: true, enabled: true, updateRequested: true, clientId: true, client: { select: { adDiscoverRequestedAt: true } } } });
      if (!agent) throw new HttpError(404, "unknown agent");
      // Tell an ENABLED agent to self-update at most once. Consume the flag with an ATOMIC
      // conditional flip (updateMany guarded by updateRequested:true) so two overlapping heartbeats
      // can't both win (double restart) and a requestUpdate() landing mid-beat isn't clobbered —
      // exactly one heartbeat flips true->false and gets update=true. A DISABLED agent keeps its
      // pending update until re-enabled (the runner ignores update when disabled, so consuming it
      // here would silently drop it).
      let update = false;
      if (agent.enabled && agent.updateRequested) {
        const consumed = await db.agent.updateMany({ where: { id: agentId, updateRequested: true }, data: { updateRequested: false } });
        update = consumed.count > 0;
      }
      // Tell this (client-network) agent to run AD discovery if its client has a pending request.
      // Consume atomically so just one of the client's agents runs it (discovery is read-only, so a
      // double-run would only be wasteful, not wrong).
      let discover = false;
      if (agent.enabled && agent.clientId && agent.client?.adDiscoverRequestedAt) {
        const consumed = await db.client.updateMany({ where: { id: agent.clientId, adDiscoverRequestedAt: { not: null } }, data: { adDiscoverRequestedAt: null } });
        discover = consumed.count > 0;
      }
      await db.agent.update({ where: { id: agentId }, data: { lastSeenAt: new Date(), version: version ?? agent.version } });
      return { ok: true, enabled: agent.enabled, update, discover };
    },

    // Operator action: ask the client's on-prem agent to (re)discover AD OUs + groups. Set the flag;
    // the next client-network heartbeat for that client consumes it and runs discovery.
    async requestAdDiscovery(clientSlug: string): Promise<{ clientId: string }> {
      const client = await db.client.findUnique({ where: { slug: clientSlug }, select: { id: true } });
      if (!client) throw new HttpError(404, "unknown client");
      const agent = await db.agent.findFirst({ where: { clientId: client.id, scope: "client_network", enabled: true, deletedAt: null }, select: { id: true } });
      if (!agent) throw new HttpError(409, "no enabled on-prem agent for this client to read its DC");
      await db.client.update({ where: { id: client.id }, data: { adDiscoverRequestedAt: new Date() } });
      await db.auditLog.create({ data: { actor: "ui", action: "client.ad_discovery.request", clientId: client.id } });
      return { clientId: client.id };
    },

    // Runner posts the discovered AD objects back; store them on the agent's client for the editor.
    async recordAdObjects(agentId: string, ous: string[], groups: string[]): Promise<{ clientId: string; ous: number; groups: number }> {
      const agent = await db.agent.findUnique({ where: { id: agentId }, select: { clientId: true } });
      if (!agent) throw new HttpError(404, "unknown agent");
      if (!agent.clientId) throw new HttpError(422, "only a client-network agent reports AD objects");
      await assertAgentEnabled(db, agentId);
      // Cap + sort + dedupe so a hostile/huge directory can't bloat the row; these are display lists.
      const clean = (xs: unknown): string[] =>
        [...new Set((Array.isArray(xs) ? xs : []).filter((x): x is string => typeof x === "string" && x.length > 0))].sort().slice(0, 5000);
      const adObjects = { ous: clean(ous), groups: clean(groups), discoveredAt: new Date().toISOString() };
      await db.client.update({ where: { id: agent.clientId }, data: { adObjects } });
      await db.auditLog.create({ data: { actor: `agent:${agentId}`, action: "client.ad_discovery.result", clientId: agent.clientId, detail: { ous: adObjects.ous.length, groups: adObjects.groups.length } } });
      return { clientId: agent.clientId, ous: adObjects.ous.length, groups: adObjects.groups.length };
    },

    // Operator action: queue a self-update. The next heartbeat returns update:true (see above).
    async requestUpdate(agentId: string): Promise<{ id: string }> {
      const agent = await db.agent.findUnique({ where: { id: agentId }, select: { id: true, enabled: true, deletedAt: true } });
      if (!agent) throw new HttpError(404, "unknown agent");
      // The UI hides Update for disabled/trashed agents, but the action is callable — guard here too:
      // a disabled agent won't heartbeat to consume the flag, so the request would just hang pending.
      if (agent.deletedAt) throw new HttpError(409, "agent is in the trash");
      if (!agent.enabled) throw new HttpError(409, "enable the runner before requesting an update");
      await db.agent.update({ where: { id: agentId }, data: { updateRequested: true } });
      await db.auditLog.create({ data: { actor: "ui", action: "agent.update_requested", detail: { agentId } } });
      return { id: agentId };
    },

    // Atomically claim up to `batchSize` eligible api jobs for this agent.
    async claim(agentId: string, batchSize: number): Promise<RunnerJob[]> {
      const agent = await db.agent.findUnique({ where: { id: agentId }, select: { id: true, clientId: true, enabled: true } });
      if (!agent) throw new HttpError(404, "unknown agent");
      if (!agent.enabled) throw new HttpError(403, "agent disabled");

      // Reclaim stale leases: a job dispatched long ago whose assigned agent is gone/stale/
      // disabled goes back to pending. Scoped to dead agents so a peer can't reset a live
      // agent's in-flight jobs (the live agent keeps lastSeenAt fresh via heartbeat).
      const staleCutoff = new Date(Date.now() - LEASE_MS);
      const stale = await db.job.findMany({
        where: {
          status: "dispatched",
          startedAt: { lt: staleCutoff },
          OR: [{ assignedAgentId: null }, { assignedAgent: { lastSeenAt: { lt: staleCutoff } } }, { assignedAgent: { enabled: false } }],
        },
        select: { id: true },
      });
      if (stale.length > 0) {
        await db.job.updateMany({ where: { id: { in: stale.map((s) => s.id) } }, data: { status: "pending", assignedAgentId: null } });
        await db.auditLog.create({ data: { actor: "system", action: "job.lease.reclaim", detail: { count: stale.length } } });
      }

      // central runner (clientId null) sees all clients' api jobs; a client agent sees only
      // its own. Jobs on a failed/completed case are excluded so a dead case can't run more.
      const candidates = await db.job.findMany({
        where: {
          status: "pending",
          mode: "api",
          case: { status: { notIn: ["failed", "completed"] }, deletedAt: null, ...(agent.clientId ? { clientId: agent.clientId } : {}) },
        },
        orderBy: [{ caseRequestId: "asc" }, { sequence: "asc" }],
        select: { id: true, caseRequestId: true, sequence: true, mode: true, status: true, request: true, case: { select: { status: true } } },
      });
      if (candidates.length === 0) return [];

      // load all jobs of the candidate cases once, for the dependency gate
      const caseIds = [...new Set(candidates.map((c) => c.caseRequestId))];
      const allJobs = await db.job.findMany({
        where: { caseRequestId: { in: caseIds } },
        select: { id: true, caseRequestId: true, sequence: true, mode: true, status: true, request: true },
      });
      const lite = (j: { id: string; sequence: number; mode: JobLite["mode"]; status: JobLite["status"]; request: unknown }): JobLite =>
        ({ id: j.id, sequence: j.sequence, mode: j.mode, status: j.status, requiresApproval: Boolean(req(j).requiresApproval), approved: Boolean(req(j).approved) });
      const byCase = new Map<string, JobLite[]>();
      for (const j of allJobs) {
        const arr = byCase.get(j.caseRequestId) ?? [];
        arr.push(lite(j));
        byCase.set(j.caseRequestId, arr);
      }

      const eligible: string[] = [];
      for (const c of candidates) {
        if (!isClaimable(lite(c), byCase.get(c.caseRequestId) ?? [], c.case.status)) continue;
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
      await db.auditLog.create({ data: { actor: `agent:${agent.id}`, action: "job.claim", detail: { count: claimed.length, jobIds: claimed.map((c) => c.id), clients: [...new Set(claimed.map((c) => c.case.client.slug))] } } });

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
          // case.dryRun is AUTHORITATIVE at claim time (the per-job request.dryRun stamp is only a
          // planning hint for the UI/playbook). Reading it here means: an absent stamp can't run a
          // dry-run case LIVE (fail-safe), a job claimed mid-toggle uses the committed case mode (no
          // TOCTOU), and an approve that rewrites request can't revert the mode. -WhatIf when true.
          dryRun: Boolean(j.case.dryRun),
        };
      });
    },

    // Broker a Delinea credential for a job. Least-privilege: the agent must own the job and
    // the secret must be one named on that job. Never returns a secret value (we store only
    // the Delinea reference); production exchanges externalId for a short-TTL scoped cred here.
    async brokerCredential(jobId: string, agentId: string, secretName: string): Promise<BrokeredCredential> {
      const job = await db.job.findUnique({ where: { id: jobId }, select: { status: true, assignedAgentId: true, request: true, case: { select: { clientId: true, secretOverrides: true } } } });
      if (!job) throw new HttpError(404, "unknown job");
      if (job.assignedAgentId !== agentId) throw new HttpError(403, "job not assigned to this agent");
      await assertAgentEnabled(db, agentId);
      if (job.status !== "dispatched" && job.status !== "running") throw new HttpError(409, `job is ${job.status}; credentials only brokered for in-progress jobs`);
      const allowed = req(job).secretNames ?? [];
      if (!allowed.includes(secretName)) throw new HttpError(403, `secret ${secretName} is not authorized for this job`);
      const clientSecret = await db.secret.findUnique({ where: { clientId_name: { clientId: job.case.clientId, name: secretName } }, select: { provider: true, externalId: true } });
      // A per-case override reference wins over the client default; either way it's a Delinea id.
      const { externalId, source } = effectiveExternalId(secretName, job.case.secretOverrides, clientSecret?.externalId ?? null);
      if (!externalId) throw new HttpError(404, `no usable secret reference '${secretName}' (set it on the client or override it on the case)`);
      // Overrides only replace the reference id, not the provider — every reference is a Delinea id.
      const secret = { provider: clientSecret?.provider ?? "delinea", externalId, source };

      // Push-down model: the app resolves the secret's VALUE from Delinea and returns the fields so
      // the runner doesn't need Delinea creds of its own (nothing to distribute to client DCs). A
      // dead/misscoped reference fails here with a clear error rather than deep in the runner. When
      // the app has no Delinea creds we can't push down — return a note so the runner says so.
      const cfg = delineaConfigFromEnv();
      let brokered = false;
      let label: string | undefined;
      let fields: Record<string, string> | undefined;
      let note: string | undefined = "Delinea not configured on the app — set DELINEA_* so the app can resolve and push the credential to the runner";
      if (delineaConfigured(cfg)) {
        const resolved = await resolveSecretFields(cfg, secret.externalId);
        if (!resolved.ok) throw new HttpError(502, `secret '${secretName}' is not resolvable in Delinea: ${resolved.error ?? "unknown error"}`);
        brokered = true;
        label = resolved.label;
        fields = resolved.fields;
        note = undefined;
      }
      // Audit records metadata ONLY — the field NAMES, never their values.
      await db.auditLog.create({ data: { actor: `agent:${agentId}`, action: "job.credential", jobId, clientId: job.case.clientId, detail: { secretName, brokered, source: secret.source, fieldNames: fields ? Object.keys(fields) : [] } } });
      return { provider: secret.provider, externalId: secret.externalId, secretName, brokered, expiresInSeconds: 300, label, note, fields };
    },

    // Record a job result, advance the case, audit, and queue a work note. The posting agent
    // must own the job; a repeat of the same terminal result is an idempotent no-op.
    async recordResult(jobId: string, agentId: string, input: ResultInput): Promise<{ jobId: string; status: string; caseStatus: string }> {
      const job = await db.job.findUnique({ where: { id: jobId }, select: { status: true, caseRequestId: true, systemKey: true, assignedAgentId: true, case: { select: { clientId: true, serviceNowCaseNumber: true } } } });
      if (!job) throw new HttpError(404, "unknown job");
      if (job.assignedAgentId !== agentId) throw new HttpError(403, "job not assigned to this agent");
      await assertAgentEnabled(db, agentId);

      const status = input.status === "succeeded" ? "succeeded" : input.status === "skipped" ? "skipped" : "failed";
      if (job.status !== "dispatched" && job.status !== "running") {
        // idempotent: a lost-ack retry of the same outcome succeeds; a conflicting re-post 409s.
        if (job.status === status) {
          const cs = await db.caseRequest.findUnique({ where: { id: job.caseRequestId }, select: { status: true } });
          return { jobId, status, caseStatus: cs?.status ?? "unknown" };
        }
        throw new HttpError(409, `job already ${job.status}`);
      }

      await db.job.update({
        where: { id: jobId },
        data: { status, result: (input.result ?? undefined) as Prisma.InputJsonValue | undefined, evidence: (input.evidence ?? undefined) as Prisma.InputJsonValue | undefined, validation: (input.validation ?? undefined) as Prisma.InputJsonValue | undefined, error: input.error ?? null, finishedAt: new Date() },
      });

      const caseJobs = await db.job.findMany({ where: { caseRequestId: job.caseRequestId }, select: { id: true, sequence: true, mode: true, status: true, request: true } });
      const caseStatus = deriveCaseStatus(caseJobs.map((j) => ({ id: j.id, sequence: j.sequence, mode: j.mode, status: j.status, requiresApproval: Boolean(req(j).requiresApproval), approved: Boolean(req(j).approved) })));
      // On case failure, cancel the still-pending jobs so they aren't orphaned forever
      // (their dependency gate could never open behind a failed predecessor anyway).
      if (caseStatus === "failed") {
        await db.job.updateMany({ where: { caseRequestId: job.caseRequestId, status: "pending" }, data: { status: "skipped" } });
      }
      await db.caseRequest.update({ where: { id: job.caseRequestId }, data: { status: caseStatus } });

      await db.auditLog.create({ data: { actor: `agent:${job.assignedAgentId ?? "unknown"}`, action: "job.result", jobId, caseRequestId: job.caseRequestId, clientId: job.case.clientId, detail: { status, error: input.error ?? null } } });
      // Work-note write-back (RUNNER_PROTOCOL): append a note to the UM ticket. postWorkNote
      // resolves the number -> sys_id and PATCHes work_notes; it's gated by SN_WRITE_ENABLED and
      // never fatal to result recording (a ServiceNow outage must not lose the job result).
      const caseNumber = job.case.serviceNowCaseNumber;
      const note = `${job.systemKey}: ${status}${input.error ? ` — ${input.error}` : ""}`;
      if (caseNumber && writeBackEnabled()) {
        try {
          const wn = await postWorkNote(snConfigFromEnv(), caseNumber, note);
          await db.auditLog.create({ data: { actor: "system", action: wn.ok ? "servicenow.worknote" : "servicenow.worknote.failed", caseRequestId: job.caseRequestId, detail: { caseNumber, note, ...(wn.ok ? { sysId: wn.sysId } : { error: wn.error }) } } });
        } catch (e) {
          await db.auditLog.create({ data: { actor: "system", action: "servicenow.worknote.failed", caseRequestId: job.caseRequestId, detail: { caseNumber, note, error: (e as Error).message } } });
        }
      } else {
        // Write-back disabled or no SN number: record the note we would have posted.
        await db.auditLog.create({ data: { actor: "system", action: "servicenow.worknote.pending", caseRequestId: job.caseRequestId, detail: { caseNumber, note } } });
      }

      return { jobId, status, caseStatus };
    },

    // Release an approval-gated job so it can be claimed. Gate is enforced here (server-side),
    // per CLAUDE.md: destructive steps need a recorded approval before dispatch.
    async approveJob(jobId: string, approvedBy: string): Promise<{ jobId: string; caseStatus: string }> {
      const job = await db.job.findUnique({ where: { id: jobId }, select: { status: true, caseRequestId: true, request: true, case: { select: { clientId: true } } } });
      if (!job) throw new HttpError(404, "unknown job");
      const r = req(job);
      if (!r.requiresApproval) throw new HttpError(409, "job does not require approval");
      if (job.status !== "pending") throw new HttpError(409, `job is ${job.status}; only a pending job can be approved`);

      await db.job.update({ where: { id: jobId }, data: { request: { ...r, approved: true } as Prisma.InputJsonValue } });
      const caseJobs = await db.job.findMany({ where: { caseRequestId: job.caseRequestId }, select: { id: true, sequence: true, mode: true, status: true, request: true } });
      const caseStatus = deriveCaseStatus(caseJobs.map((j) => ({ id: j.id, sequence: j.sequence, mode: j.mode, status: j.status, requiresApproval: Boolean(req(j).requiresApproval), approved: Boolean(req(j).approved) })));
      await db.caseRequest.update({ where: { id: job.caseRequestId }, data: { status: caseStatus } });
      await db.auditLog.create({ data: { actor: approvedBy, action: "job.approve", jobId, caseRequestId: job.caseRequestId, clientId: job.case.clientId, detail: { approvedBy } } });
      return { jobId, caseStatus };
    },
  };
}

export type RunnerService = ReturnType<typeof makeRunnerService>;
