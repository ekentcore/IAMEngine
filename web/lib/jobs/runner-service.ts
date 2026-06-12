// Runner coordination: enrollment, heartbeat, atomic claim, credential broker, result +
// case advance. Factory-style over PrismaClient, mirroring lib/clients/repository.ts.
// Pure decisions live in runner-logic.ts; this layer is the I/O around them.
import type { AgentScope, PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { deriveCaseStatus, isClaimable, type JobLite } from "./runner-logic";
import { HttpError, type BrokeredCredential, type ResultInput, type RunnerJob } from "./types";
import { resolveSecretFields, delineaConfigFromEnv, delineaConfigured } from "../secrets/delinea";
import { effectiveExternalId, missingRequiredSecrets, ALWAYS_ON_PREM_SYSTEMS, systemIsOnPrem } from "../cases/case-secrets";
import { purgeCutoff } from "./agent-trash";
import { sweepProcurementWatches } from "./procurement-watch";
import { postWorkNote, writeBackEnabled } from "../servicenow/worknote";
import { snConfigFromEnv } from "../servicenow/gateway";

type JobRequest = { config?: unknown; requiresApproval?: boolean; captureEvidence?: boolean; secretNames?: string[]; approved?: boolean; dryRun?: boolean; validateOnly?: boolean };

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
        // Stamp updateDeliveredAt on consume → the UI shows "updating…" until the agent restarts and
        // its next heartbeat pushes lastSeenAt past this timestamp ("updated ✓").
        const consumed = await db.agent.updateMany({ where: { id: agentId, updateRequested: true }, data: { updateRequested: false, updateDeliveredAt: new Date() } });
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
      // Heartbeats double as the app's pulse: piggyback the procurement-case sweep (PC resolved ->
      // re-queue the blocked job). Fire-and-forget — a SN hiccup must never fail a heartbeat. The
      // sweep self-throttles to ~1/min and checks each watch every ~5 min.
      void sweepProcurementWatches(db).catch(() => {});
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
      // Cap count AND per-string length, sort + dedupe — a hostile/spoofed runner can't bloat the row
      // or DoS the editor's substring filter with huge strings (a real DN/group name is well < 512).
      const clean = (xs: unknown): string[] =>
        [...new Set((Array.isArray(xs) ? xs : []).filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 512))].sort().slice(0, 5000);
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
      await db.agent.update({ where: { id: agentId }, data: { updateRequested: true, updateRequestedAt: new Date(), updateDeliveredAt: null } });
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
      // Host affinity: the central (cloud) runner must NOT claim systems that require on-prem
      // execution (the ActiveDirectory/RSAT module, the EXO cert + on-prem Exchange session, the
      // ADSync module) — those only work on the client-network agent. Otherwise it grabs an AD job it
      // can't run ("Invoke-CtgADOnboarding not recognized"). Client agents still claim everything.
      const candidates = await db.job.findMany({
        where: {
          status: "pending",
          mode: "api",
          case: { status: { notIn: ["failed", "completed"] }, deletedAt: null, pausedAt: null, ...(agent.clientId ? { clientId: agent.clientId } : {}) },
          ...(agent.clientId ? {} : { systemKey: { notIn: ALWAYS_ON_PREM_SYSTEMS } }),
        },
        orderBy: [{ caseRequestId: "asc" }, { sequence: "asc" }],
        select: { id: true, caseRequestId: true, systemKey: true, sequence: true, mode: true, status: true, request: true, case: { select: { status: true } } },
      });
      if (candidates.length === 0) return [];

      // load all jobs of the candidate cases once, for the dependency gate
      const caseIds = [...new Set(candidates.map((c) => c.caseRequestId))];
      const allJobs = await db.job.findMany({
        where: { caseRequestId: { in: caseIds } },
        select: { id: true, caseRequestId: true, systemKey: true, sequence: true, mode: true, status: true, request: true },
      });
      const lite = (j: { id: string; systemKey: string; sequence: number; mode: JobLite["mode"]; status: JobLite["status"]; request: unknown }): JobLite => {
        const r = req(j) as { requiresApproval?: boolean; approved?: boolean; dependsOn?: unknown };
        const deps = Array.isArray(r.dependsOn) ? (r.dependsOn as unknown[]).filter((d): d is string => typeof d === "string") : null;
        return { id: j.id, systemKey: j.systemKey, sequence: j.sequence, mode: j.mode, status: j.status, requiresApproval: Boolean(r.requiresApproval), approved: Boolean(r.approved), dependsOn: deps };
      };
      const byCase = new Map<string, JobLite[]>();
      for (const j of allJobs) {
        const arr = byCase.get(j.caseRequestId) ?? [];
        arr.push(lite(j));
        byCase.set(j.caseRequestId, arr);
      }
      // A case is "hybrid" — its exchange runs on the on-prem agent — only if it actually has an
      // AD/sync job. Without one, exchange is Exchange Online and the central runner CAN run it.
      const hybridCases = new Set(allJobs.filter((j) => ALWAYS_ON_PREM_SYSTEMS.includes(j.systemKey)).map((j) => j.caseRequestId));

      // Preflight: don't claim a job whose required secrets aren't set — the broker couldn't resolve a
      // credential, so it would just fail. Load the candidate cases' client refs + overrides once.
      const caseMeta = await db.caseRequest.findMany({ where: { id: { in: caseIds } }, select: { id: true, clientId: true, secretOverrides: true } });
      const caseMetaById = new Map(caseMeta.map((c) => [c.id, c]));
      const clientSecrets = await db.secret.findMany({ where: { clientId: { in: [...new Set(caseMeta.map((c) => c.clientId))] } }, select: { clientId: true, name: true, externalId: true } });
      const secretsByClient = new Map<string, Map<string, string | null>>();
      for (const s of clientSecrets) {
        const m = secretsByClient.get(s.clientId) ?? new Map<string, string | null>();
        m.set(s.name, s.externalId);
        secretsByClient.set(s.clientId, m);
      }

      const eligible: string[] = [];
      for (const c of candidates) {
        if (!isClaimable(lite(c), byCase.get(c.caseRequestId) ?? [], c.case.status)) continue;
        // Host affinity: the central runner can't run an on-prem step (only exchange reaches here, and
        // only for a hybrid case). A client agent (agent.clientId set) runs everything for its client.
        if (!agent.clientId && systemIsOnPrem(c.systemKey, hybridCases.has(c.caseRequestId))) continue;
        const meta = caseMetaById.get(c.caseRequestId);
        const clientMap = (meta && secretsByClient.get(meta.clientId)) ?? new Map<string, string | null>();
        if (missingRequiredSecrets(req(c).secretNames, meta?.secretOverrides, clientMap).length > 0) continue; // secrets not set — skip
        eligible.push(c.id);
        if (eligible.length >= batchSize) break;
      }
      if (eligible.length === 0) return [];

      // atomic: only rows still pending flip; a racing agent's updateMany skips already-claimed rows.
      // Clear progress here so every (re-)run starts with a fresh phase trail, not stale phases from a
      // prior attempt — DbNull writes SQL NULL.
      await db.job.updateMany({
        where: { id: { in: eligible }, status: "pending" },
        data: { status: "dispatched", assignedAgentId: agent.id, startedAt: new Date(), progress: Prisma.DbNull },
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
          // Verify pass: run only the read-only validator (Confirm-Ctg*), no mutations. Per-job stamp
          // set by the case-level "Verify" action.
          validateOnly: Boolean(r.validateOnly),
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
      if (source === "not_needed") throw new HttpError(409, `secret '${secretName}' is marked not needed (handled as a manual step) — no credential to broker`);
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

    // --- Connection tests (isolated permission preflight) ----------------------------------------
    // A separate lane from the Job pipeline: the runner connects with the brokered credential and
    // does one cheap authorized read, proving the cred not only resolves but actually has access.
    // Routed like a job (cloud -> central runner, on-prem -> client agent) via the onPrem flag.

    // Queue a fresh set of tests for a client (replaces any prior run). One row per api system that
    // actually connects to something (has a required secret).
    async requestConnectionTests(clientSlug: string): Promise<{ tests: { systemKey: string; onPrem: boolean }[] }> {
      const client = await db.client.findUnique({
        where: { slug: clientSlug },
        select: { id: true, systems: { select: { systemKey: true, mode: true, secretNames: true } } },
      });
      if (!client) throw new HttpError(404, `unknown client ${clientSlug}`);
      const hasAd = client.systems.some((s) => ALWAYS_ON_PREM_SYSTEMS.includes(s.systemKey));
      const testable = client.systems.filter((s) => s.mode === "api" && (s.secretNames?.length ?? 0) > 0);
      await db.connectionTest.deleteMany({ where: { clientId: client.id } });
      if (testable.length === 0) return { tests: [] };
      const rows = testable.map((s) => ({ clientId: client.id, systemKey: s.systemKey, secretNames: s.secretNames ?? [], onPrem: systemIsOnPrem(s.systemKey, hasAd) }));
      await db.connectionTest.createMany({ data: rows });
      return { tests: rows.map((r) => ({ systemKey: r.systemKey, onPrem: r.onPrem })) };
    },

    async listConnectionTests(clientSlug: string) {
      const client = await db.client.findUnique({ where: { slug: clientSlug }, select: { id: true } });
      if (!client) throw new HttpError(404, `unknown client ${clientSlug}`);
      const tests = await db.connectionTest.findMany({
        where: { clientId: client.id },
        orderBy: { systemKey: "asc" },
        select: { systemKey: true, status: true, detail: true, onPrem: true, finishedAt: true },
      });
      return { tests };
    },

    // Atomic claim, same scope rule as job claim: a central runner (no clientId) takes only cloud
    // tests; a client agent takes its own client's (cloud + on-prem).
    async claimConnectionTests(agentId: string, max = 5): Promise<{ id: string; systemKey: string; secretNames: string[]; clientSlug: string; primaryDomain: string }[]> {
      const agent = await db.agent.findUnique({ where: { id: agentId }, select: { id: true, enabled: true, clientId: true } });
      if (!agent) throw new HttpError(404, "unknown agent");
      if (!agent.enabled) return [];
      const where = { status: "pending", ...(agent.clientId ? { clientId: agent.clientId } : { onPrem: false }) };
      const candidates = await db.connectionTest.findMany({ where, orderBy: { requestedAt: "asc" }, take: Math.max(1, Math.min(25, max)), select: { id: true } });
      if (candidates.length === 0) return [];
      const ids = candidates.map((c) => c.id);
      await db.connectionTest.updateMany({ where: { id: { in: ids }, status: "pending" }, data: { status: "running", assignedAgentId: agent.id, claimedAt: new Date() } });
      const claimed = await db.connectionTest.findMany({
        where: { id: { in: ids }, assignedAgentId: agent.id, status: "running" },
        select: { id: true, systemKey: true, secretNames: true, client: { select: { slug: true, primaryDomain: true } } },
      });
      return claimed.map((t) => ({ id: t.id, systemKey: t.systemKey, secretNames: t.secretNames, clientSlug: t.client.slug, primaryDomain: t.client.primaryDomain }));
    },

    // Same push-down broker as a job, scoped to the test's own secretNames (no case overrides).
    async brokerConnectionTestCredential(testId: string, agentId: string, secretName: string): Promise<BrokeredCredential> {
      const t = await db.connectionTest.findUnique({ where: { id: testId }, select: { status: true, assignedAgentId: true, secretNames: true, clientId: true } });
      if (!t) throw new HttpError(404, "unknown connection test");
      if (t.assignedAgentId !== agentId) throw new HttpError(403, "connection test not assigned to this agent");
      await assertAgentEnabled(db, agentId);
      if (t.status !== "running") throw new HttpError(409, `connection test is ${t.status}; credentials only brokered while running`);
      if (!t.secretNames.includes(secretName)) throw new HttpError(403, `secret ${secretName} is not authorized for this connection test`);
      const clientSecret = await db.secret.findUnique({ where: { clientId_name: { clientId: t.clientId, name: secretName } }, select: { provider: true, externalId: true } });
      const { externalId, source } = effectiveExternalId(secretName, null, clientSecret?.externalId ?? null);
      if (source === "not_needed") throw new HttpError(409, `secret '${secretName}' is marked not needed (manual step) — nothing to test`);
      if (!externalId) throw new HttpError(404, `no usable secret reference '${secretName}' (set it on the client)`);
      const cfg = delineaConfigFromEnv();
      let brokered = false; let label: string | undefined; let fields: Record<string, string> | undefined;
      let note: string | undefined = "Delinea not configured on the app — set DELINEA_* so the app can resolve and push the credential";
      if (delineaConfigured(cfg)) {
        const resolved = await resolveSecretFields(cfg, externalId);
        if (!resolved.ok) throw new HttpError(502, `secret '${secretName}' is not resolvable in Delinea: ${resolved.error ?? "unknown error"}`);
        brokered = true; label = resolved.label; fields = resolved.fields; note = undefined;
      }
      await db.auditLog.create({ data: { actor: `agent:${agentId}`, action: "conntest.credential", clientId: t.clientId, detail: { secretName, brokered, fieldNames: fields ? Object.keys(fields) : [] } } });
      return { provider: clientSecret?.provider ?? "delinea", externalId, secretName, brokered, expiresInSeconds: 300, label, note, fields };
    },

    async reportConnectionTest(testId: string, agentId: string, ok: boolean, detail: string): Promise<{ ok: true }> {
      const t = await db.connectionTest.findUnique({ where: { id: testId }, select: { assignedAgentId: true, clientId: true, systemKey: true } });
      if (!t) throw new HttpError(404, "unknown connection test");
      if (t.assignedAgentId !== agentId) throw new HttpError(403, "connection test not assigned to this agent");
      await db.connectionTest.update({ where: { id: testId }, data: { status: ok ? "ok" : "fail", detail: (detail ?? "").slice(0, 500), finishedAt: new Date() } });
      await db.auditLog.create({ data: { actor: `agent:${agentId}`, action: "conntest.result", clientId: t.clientId, detail: { systemKey: t.systemKey, ok } } });
      return { ok: true };
    },

    // Live progress: the runner posts the phase it's entering ("connecting to Exchange Online",
    // "enabling remote mailbox", …) as it works, so the run report can show what a step is doing
    // right now instead of an opaque "running". Best-effort + append-only (last 20), and only while
    // the job is in flight — a late post after the job finished is ignored, not an error.
    async recordProgress(jobId: string, agentId: string, phase: string): Promise<{ ok: true }> {
      const job = await db.job.findUnique({ where: { id: jobId }, select: { status: true, assignedAgentId: true, progress: true } });
      if (!job) throw new HttpError(404, "unknown job");
      if (job.assignedAgentId !== agentId) throw new HttpError(403, "job not assigned to this agent");
      if (job.status !== "dispatched" && job.status !== "running") return { ok: true }; // job already done — drop
      const trail = Array.isArray(job.progress) ? (job.progress as unknown[]) : [];
      const next = [...trail, { ts: new Date().toISOString(), phase: String(phase).slice(0, 200) }].slice(-20);
      // Stamp running on the first progress post so the case/step reflects in-flight immediately.
      await db.job.update({ where: { id: jobId }, data: { progress: next as Prisma.InputJsonValue, status: "running" } });
      return { ok: true };
    },

    // Record a job result, advance the case, audit, and queue a work note. The posting agent
    // must own the job; a repeat of the same terminal result is an idempotent no-op.
    async recordResult(jobId: string, agentId: string, input: ResultInput): Promise<{ jobId: string; status: string; caseStatus: string }> {
      const job = await db.job.findUnique({ where: { id: jobId }, select: { status: true, caseRequestId: true, systemKey: true, assignedAgentId: true, request: true, case: { select: { clientId: true, serviceNowCaseNumber: true } } } });
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

      // AUTO-RETRY: a succeeded result carrying RetryAfterMinutes (e.g. Spanning/Mimecast "user not
      // discovered yet") schedules its own re-run; sweepAutoRetries re-queues it when due. A result
      // WITHOUT the marker clears any schedule (the wait is over) and audits the elapsed time.
      if (status === "succeeded" && !req(job).validateOnly) {
        const marker = (input.result ?? {}) as { RetryAfterMinutes?: unknown; retryAfterMinutes?: unknown };
        const mins = Number(marker.RetryAfterMinutes ?? marker.retryAfterMinutes ?? 0);
        const reqJson = { ...(job.request as Record<string, unknown> ?? {}) };
        const prev = (reqJson.autoRetry ?? null) as { count?: number; firstAt?: number } | null;
        if (mins > 0 && (prev?.count ?? 0) < 16) {
          reqJson.autoRetry = { at: Date.now() + mins * 60_000, count: (prev?.count ?? 0) + 1, firstAt: prev?.firstAt ?? Date.now() };
          await db.job.update({ where: { id: jobId }, data: { request: reqJson as Prisma.InputJsonValue } });
        } else if (prev) {
          delete reqJson.autoRetry;
          await db.job.update({ where: { id: jobId }, data: { request: reqJson as Prisma.InputJsonValue } });
          if (mins === 0) {
            await db.auditLog.create({ data: { actor: "system:auto-retry", action: "job.autoretry.resolved", jobId, caseRequestId: job.caseRequestId, detail: { attempts: prev.count ?? 0, elapsedMinutes: prev.firstAt ? Math.round((Date.now() - prev.firstAt) / 60_000) : null } } });
          }
        }
      }


      const caseJobs = await db.job.findMany({ where: { caseRequestId: job.caseRequestId }, select: { id: true, systemKey: true, sequence: true, mode: true, status: true, request: true } });
      let caseStatus = deriveCaseStatus(caseJobs.map((j) => ({ id: j.id, systemKey: j.systemKey, sequence: j.sequence, mode: j.mode, status: j.status, requiresApproval: Boolean(req(j).requiresApproval), approved: Boolean(req(j).approved) })));
      // On case failure, cancel the still-pending jobs so they aren't orphaned forever
      // (their dependency gate could never open behind a failed predecessor anyway).
      if (caseStatus === "failed") {
        await db.job.updateMany({ where: { caseRequestId: job.caseRequestId, status: "pending" }, data: { status: "skipped" } });
      }

      // Auto-verify: when the automated work first finishes, run a read-only validation sweep across
      // every step (re-run each Confirm-Ctg*) once — confirming accounts/licensing/mirroring/access
      // all landed after everything settled — before the case is "done" and the operator resolves it.
      // validateOnly = the sweep itself; verifiedAt guards against looping.
      if (caseStatus === "completed") {
        const cr = await db.caseRequest.findUnique({ where: { id: job.caseRequestId }, select: { verifiedAt: true } });
        if (!cr?.verifiedAt) {
          const thisJob = caseJobs.find((j) => j.id === jobId);
          const thisWasVerify = Boolean(thisJob && req(thisJob).validateOnly);
          if (thisWasVerify) {
            await db.caseRequest.update({ where: { id: job.caseRequestId }, data: { verifiedAt: new Date() } });
          } else {
            // Re-validate every succeeded automated step that has a validator (skip servicenow/case-resolution).
            const sweep = caseJobs.filter((j) => j.mode === "api" && j.status === "succeeded" && !["servicenow", "case-resolution"].includes(j.systemKey));
            if (sweep.length) {
              await db.$transaction(sweep.map((j) =>
                db.job.update({ where: { id: j.id }, data: { status: "pending", assignedAgentId: null, validation: Prisma.DbNull, progress: Prisma.DbNull, error: null, finishedAt: null, request: { ...((j.request ?? {}) as object), validateOnly: true } as Prisma.InputJsonValue } })
              ));
              caseStatus = "running"; // verifying
              await db.auditLog.create({ data: { actor: "system", action: "case.auto_verify", caseRequestId: job.caseRequestId, detail: { steps: sweep.length } } });
            } else {
              await db.caseRequest.update({ where: { id: job.caseRequestId }, data: { verifiedAt: new Date() } });
            }
          }
        }
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
      const caseJobs = await db.job.findMany({ where: { caseRequestId: job.caseRequestId }, select: { id: true, systemKey: true, sequence: true, mode: true, status: true, request: true } });
      const caseStatus = deriveCaseStatus(caseJobs.map((j) => ({ id: j.id, systemKey: j.systemKey, sequence: j.sequence, mode: j.mode, status: j.status, requiresApproval: Boolean(req(j).requiresApproval), approved: Boolean(req(j).approved) })));
      await db.caseRequest.update({ where: { id: job.caseRequestId }, data: { status: caseStatus } });
      await db.auditLog.create({ data: { actor: approvedBy, action: "job.approve", jobId, caseRequestId: job.caseRequestId, clientId: job.case.clientId, detail: { approvedBy } } });
      return { jobId, caseStatus };
    },
  };
}

export type RunnerService = ReturnType<typeof makeRunnerService>;
