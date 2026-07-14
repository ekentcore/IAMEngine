// Runner coordination: enrollment, heartbeat, atomic claim, credential broker, result +
// case advance. Factory-style over PrismaClient, mirroring lib/clients/repository.ts.
// Pure decisions live in runner-logic.ts; this layer is the I/O around them.
import type { AgentScope, CaseStatus, PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { deriveCaseStatus, isClaimable, shouldStandBy, setupGateBlocks, type JobLite, type SetupGatePolicy } from "./runner-logic";
import { getAppSetting } from "../settings";

// AppSetting key for the setup-state dispatch gate ({ enforceTested: boolean }, default off).
export const SETUP_GATE_KEY = "setup_gate";
import { PASSWORD_RESET_SYSTEM_KEYS } from "./password-reset";
import { ADHOC_SYSTEM_KEYS } from "./adhoc";
import { HttpError, type BrokeredCredential, type ResultInput, type RunnerJob } from "./types";
import { resolveSecretFields, delineaConfigFromEnv, delineaConfigured, getDelineaToken, getOneTimePasswordCode } from "../secrets/delinea";
import { checkFieldShape } from "../secrets/field-requirements";
import { classifyDelineaError, credFailure, type CredFailure } from "./cred-failure";
import { testableSystems, type RightsRow } from "./conn-test-logic";
import { wiredOptionalSecrets } from "../secrets/auxiliary";
import { diffConnOutcome, sweepConnTests } from "./conn-sweep";
import { sweepDbBackup } from "./db-backup";
import { effectiveExternalId, missingRequiredSecrets, ALWAYS_ON_PREM_SYSTEMS, systemIsOnPrem } from "../cases/case-secrets";
import { parseCapabilities, onPremExclusions, browserExclusions } from "../runner/capabilities";
import { purgeCutoff } from "./agent-trash";
import { generateInitialPassword } from "../auth/password";
import { sweepProcurementWatches } from "./procurement-watch";
import { sweepServiceNowIntake } from "./intake-sweep";
import { postWorkNote, writeBackEnabled } from "../servicenow/worknote";
import { snConfigFromEnv } from "../servicenow/gateway";
import { jobOutcome } from "../cases/run-report";
import { fireNotification } from "../notifications/sender";
import { parseClientOverride } from "../notifications/types";
import { outcomeFingerprint } from "../runs/outcomes-repo";
import { runnerBuildId } from "../runner/bundle";
import { agentBuildIsCurrent, AGENT_AUTO_UPDATE_KEY } from "./agent-updates";
import { decideAutoRetry, type AutoRetryMarker } from "./auto-retry";

type JobRequest = { config?: unknown; requiresApproval?: boolean; captureEvidence?: boolean; secretNames?: string[]; approved?: boolean; dryRun?: boolean; validateOnly?: boolean };

const req = (j: { request: unknown }): JobRequest => (j.request ?? {}) as JobRequest;

// The offboard-target shortlist an executor returns when it cannot tell WHICH person to offboard —
// result.Candidates (PowerShell) / result.candidates. See recordResult: a result carrying these is a
// DECISION, never a success. Shape mirrors the runner's: { id, upn, displayName, ... }.
export type OffboardCandidate = {
  id: string; upn: string; displayName: string; jobTitle?: string; department?: string;
  enabled?: boolean; mail?: string; samAccountName?: string; source?: string;
};

export function offboardCandidatesOf(result: unknown): OffboardCandidate[] {
  if (!result || typeof result !== "object") return [];
  const r = result as Record<string, unknown>;
  const raw = r.Candidates ?? r.candidates;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c) => (c ?? {}) as Record<string, unknown>)
    // A candidate with no identifier is unusable — the operator could pick it and we'd still not know who they meant.
    .filter((c) => typeof c.upn === "string" && c.upn.length > 0)
    .map((c) => ({
      id: String(c.id ?? c.upn),
      upn: String(c.upn),
      displayName: String(c.displayName ?? c.upn),
      jobTitle: c.jobTitle ? String(c.jobTitle) : undefined,
      department: c.department ? String(c.department) : undefined,
      enabled: typeof c.enabled === "boolean" ? c.enabled : undefined,
      mail: c.mail ? String(c.mail) : undefined,
      samAccountName: c.samAccountName ? String(c.samAccountName) : undefined,
      source: c.source ? String(c.source) : undefined,
    }));
}

// The name we searched for (what ServiceNow gave us) — shown to the operator so they can see WHY we
// couldn't resolve it ("we looked for 'Parth Shah'; the directory has 'Parth K. Shah'").
export function offboardCandidateQuery(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  const q = r.CandidateQuery ?? r.candidateQuery;
  return typeof q === "string" && q ? q : null;
}

// Same marker convention as the username-collision decision, so the UI can key off the error text.
function offboardDecisionError(result: unknown, count: number): string {
  const r = (result ?? {}) as Record<string, unknown>;
  const reason = String(r.CandidateReason ?? r.candidateReason ?? "ambiguous");
  const query = offboardCandidateQuery(result) ?? "the name on the ticket";
  const why = reason === "no-match"
    ? `no exact match for "${query}"`
    : `${count} users match "${query}"`;
  return `DECISION_NEEDED:offboard_target | ${why} — pick the user to offboard, then the case re-runs from the start. Nothing was changed.`;
}

// One shape for every ConnectionTest row, whichever path enqueued it — otherwise the fleet sweep and
// the per-client button disagree about what a system needs, and a probe reports "no portal secret
// wired" for a client that has one. REQUIRED secrets come from the system; OPTIONAL ones are attached
// only when the client has actually wired them and are brokered best-effort by the runner.
function connTestRow(
  clientId: string,
  s: { systemKey: string; secretNames: string[]; config: unknown; onPrem: boolean },
  clientSecrets: { name: string; externalId: string | null }[],
  source: "manual" | "sweep",
  deep: boolean
) {
  return {
    clientId,
    systemKey: s.systemKey,
    secretNames: s.secretNames,
    optionalSecretNames: wiredOptionalSecrets(s.systemKey, clientSecrets).filter((n) => !s.secretNames.includes(n)),
    config: (s.config ?? undefined) as Prisma.InputJsonValue | undefined,
    onPrem: s.onPrem,
    source,
    deep,
  };
}

// A claimed job whose runner never posts a result is reclaimed after this long (crash/stall).
const LEASE_MS = 10 * 60 * 1000;
// A "running" job whose progress hasn't moved in this long has wedged (the worker died / a step hung
// past the runner's 10-min watchdog). Generous so a genuinely-slow-but-narrating step never trips it.
const PROGRESS_STALE_MS = 20 * 60 * 1000;
const MAX_PROGRESS_RECLAIMS = 1; // re-queue a wedged job once; if it wedges again, FAIL it (don't loop)

// Re-derive a case's status from its jobs and persist it; on failure, cancel the still-pending jobs
// (their dependency gate can never open behind a failed predecessor). Shared by the wedged-job reclaim
// and the operator Stop so they advance the case exactly like a real job result does.
async function refreshCaseStatus(db: PrismaClient, caseRequestId: string) {
  const caseJobs = await db.job.findMany({ where: { caseRequestId }, select: { id: true, systemKey: true, sequence: true, mode: true, status: true, request: true } });
  const caseStatus = deriveCaseStatus(caseJobs.map((j) => ({ id: j.id, systemKey: j.systemKey, sequence: j.sequence, mode: j.mode, status: j.status, requiresApproval: Boolean(req(j).requiresApproval), approved: Boolean(req(j).approved) })));
  if (caseStatus === "failed") {
    await db.job.updateMany({ where: { caseRequestId, status: "pending" }, data: { status: "skipped" } });
  }
  await db.caseRequest.update({ where: { id: caseRequestId }, data: { status: caseStatus } });
  return caseStatus;
}


// An agent disabled mid-flight must not keep brokering credentials or posting results.
async function assertAgentEnabled(db: PrismaClient, agentId: string): Promise<void> {
  const agent = await db.agent.findUnique({ where: { id: agentId }, select: { enabled: true } });
  if (!agent) throw new HttpError(404, "unknown agent");
  if (!agent.enabled) throw new HttpError(403, "agent disabled");
}

// App-side connection-test preflight (the "Fields" stage): resolve each queued row's secrets from
// Delinea and shape-check the FIELD NAMES against the provider requirements, persisting the verdict
// on the just-created rows. Secret values never leave this function — details carry names and
// missing-requirement labels only. Best-effort by design: callers swallow errors so the runner's
// access/API stages always still run.
async function preflightConnTestFields(
  db: PrismaClient,
  clientId: string,
  primaryDomain: string | null,
  specs: { systemKey: string; secretNames: string[] }[]
): Promise<void> {
  const cfg = delineaConfigFromEnv();
  if (!delineaConfigured(cfg)) {
    await db.connectionTest.updateMany({
      where: { clientId, systemKey: { in: specs.map((s) => s.systemKey) }, status: "pending" },
      data: { fieldsDetail: "Delinea not configured on the app — set DELINEA_* to enable the field preflight" },
    });
    return;
  }
  const names = [...new Set(specs.flatMap((s) => s.secretNames))];
  const secrets = await db.secret.findMany({ where: { clientId, name: { in: names } }, select: { name: true, externalId: true } });
  const byName = new Map(secrets.map((s) => [s.name, s.externalId] as const));
  const hasTenantHint = Boolean(primaryDomain && primaryDomain.trim());
  // One token for the whole batch — not one password-grant per secret.
  let token: string | undefined;
  let tokenError: string | null = null;
  try {
    token = await getDelineaToken(cfg);
  } catch (e) {
    tokenError = e instanceof Error ? e.message : "token grant failed";
  }
  // Resolve each distinct secret once, then stamp the verdict per system.
  const checks = new Map<string, { ok: boolean; note: string }>();
  for (const name of names) {
    if (tokenError) { checks.set(name, { ok: false, note: `${name}: Delinea unreachable (${tokenError})` }); continue; }
    const { externalId, source } = effectiveExternalId(name, null, byName.get(name) ?? null);
    if (source === "not_needed") { checks.set(name, { ok: true, note: `${name}: not needed` }); continue; }
    if (!externalId) { checks.set(name, { ok: false, note: `${name}: no reference set` }); continue; }
    const resolved = await resolveSecretFields(cfg, externalId, undefined, token);
    if (!resolved.ok) { checks.set(name, { ok: false, note: `${name}: ${resolved.error ?? "not resolvable"}` }); continue; }
    // Opportunistic expiry capture — never fails the preflight.
    if (resolved.expiresAt) {
      const at = new Date(resolved.expiresAt);
      if (!Number.isNaN(at.getTime())) await db.secret.updateMany({ where: { clientId, name }, data: { expiresAt: at, expiryCheckedAt: new Date() } }).catch(() => {});
    }
    const shape = checkFieldShape(name, Object.keys(resolved.fields ?? {}), { clientHasTenantHint: hasTenantHint });
    checks.set(
      name,
      shape.missing.length === 0
        ? { ok: true, note: `${name}: fields ok` }
        : { ok: false, note: `${name}: missing ${shape.missing.join(", ")}` }
    );
  }
  for (const spec of specs) {
    const rows = spec.secretNames.map((n) => checks.get(n)).filter((r): r is { ok: boolean; note: string } => Boolean(r));
    if (rows.length === 0) continue;
    await db.connectionTest.updateMany({
      where: { clientId, systemKey: spec.systemKey, status: "pending" },
      data: { fieldsOk: rows.every((r) => r.ok), fieldsDetail: rows.map((r) => r.note).join("; ").slice(0, 500) || null },
    });
  }
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

    async heartbeat(agentId: string, version?: string | null, semver?: string | null, startedAt?: string | null, capabilities?: string[] | null): Promise<{ ok: true; enabled: boolean; update: boolean; restart: boolean; discover: boolean }> {
      const agent = await db.agent.findUnique({ where: { id: agentId }, select: { id: true, version: true, semver: true, enabled: true, updateRequested: true, updateDeliveredAt: true, restartRequested: true, clientId: true, client: { select: { adDiscoverRequestedAt: true } } } });
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
      // Auto-update stale agents (default ON): if this agent is enabled, not already updating, and the
      // build it just reported differs from the build the app now serves, tell it to self-update. This
      // is what makes a server restart (new bundle) roll the fleet forward on its own — no per-agent
      // click. A short cooldown via updateDeliveredAt keeps it from re-issuing every ~5s heartbeat
      // while the agent is mid-pull; a failed update naturally retries after the cooldown.
      if (!update && agent.enabled) {
        const reported = version ?? agent.version;
        const cooldownOver = !agent.updateDeliveredAt || Date.now() - agent.updateDeliveredAt.getTime() > 90_000;
        // Only pay for the settings read when this agent is actually on a stale build — an up-to-date
        // agent (the common case) short-circuits before the DB round-trip.
        if (cooldownOver && !agentBuildIsCurrent(reported, runnerBuildId())) {
          const autoUpdate = (await getAppSetting<{ enabled?: boolean }>(db, AGENT_AUTO_UPDATE_KEY))?.enabled !== false; // default on
          if (autoUpdate) {
            update = true;
            await db.agent.update({ where: { id: agentId }, data: { updateDeliveredAt: new Date(), updateRequestedBy: "system:auto-update", updateRequestedAt: new Date() } }).catch(() => {});
          }
        }
      }
      // Same atomic-consume for a plain RESTART request (no file pull). An update already restarts, so
      // if both are pending the update wins and this just clears the redundant flag.
      let restart = false;
      if (agent.enabled && agent.restartRequested) {
        const consumed = await db.agent.updateMany({ where: { id: agentId, restartRequested: true }, data: { restartRequested: false, restartDeliveredAt: new Date() } });
        restart = consumed.count > 0;
      }
      // Tell this (client-network) agent to run AD discovery if its client has a pending request.
      // Consume atomically so just one of the client's agents runs it (discovery is read-only, so a
      // double-run would only be wasteful, not wrong).
      let discover = false;
      if (agent.enabled && agent.clientId && agent.client?.adDiscoverRequestedAt) {
        const consumed = await db.client.updateMany({ where: { id: agent.clientId, adDiscoverRequestedAt: { not: null } }, data: { adDiscoverRequestedAt: null } });
        discover = consumed.count > 0;
      }
      // bootAt = the runner's reported process start (for the uptime display). Parse defensively; only
      // set it when a valid value is sent (older runners don't report it — keep whatever's stored).
      const boot = startedAt ? new Date(startedAt) : null;
      const bootAt = boot && !Number.isNaN(boot.getTime()) ? boot : undefined;
      // Persist reported on-prem capabilities only when the runner sent them (1.31+). A legacy runner
      // passes null → keep whatever's stored (stays null → treated as capable). An empty array IS a
      // report ("can run no on-prem system") and is persisted as [].
      await db.agent.update({ where: { id: agentId }, data: { lastSeenAt: new Date(), version: version ?? agent.version, semver: semver ?? agent.semver, ...(bootAt ? { bootAt } : {}), ...(capabilities != null ? { capabilities: capabilities as Prisma.InputJsonValue } : {}) } });
      // Heartbeats double as the app's pulse: piggyback the procurement-case sweep (PC resolved ->
      // re-queue the blocked job). Fire-and-forget — a SN hiccup must never fail a heartbeat. The
      // sweep self-throttles to ~1/min and checks each watch every ~5 min.
      void sweepProcurementWatches(db).catch(() => {});
      // Same pulse: auto-import new ServiceNow intake tickets (off unless enabled; self-throttles to ~15 min).
      void sweepServiceNowIntake(db).catch(() => {});
      // Same pulse: the scheduled credential-health sweep + expiry alerts (off unless enabled;
      // durable AppSetting throttle, one client batch per tick). Reuses the operator enqueue path.
      const svc = this;
      void sweepConnTests(db, { enqueueClient: (slug, source) => svc.requestConnectionTests(slug, undefined, source) }).catch(() => {});
      // Same pulse: the nightly pg_dump database backup (default ON; durable AppSetting throttle,
      // one run per night after the configured local hour). See lib/jobs/db-backup.ts.
      void sweepDbBackup(db).catch(() => {});
      return { ok: true, enabled: agent.enabled, update, restart, discover };
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
    // actor = the operator who requested it (their email), recorded in the audit log AND stamped on
    // the agent (updateRequestedBy) so the Agents page can show WHO pushed the update. Defaults to
    // "ui" only when no identity is available (auth off).
    async requestUpdate(agentId: string, actor = "ui"): Promise<{ id: string }> {
      const agent = await db.agent.findUnique({ where: { id: agentId }, select: { id: true, enabled: true, deletedAt: true } });
      if (!agent) throw new HttpError(404, "unknown agent");
      // The UI hides Update for disabled/trashed agents, but the action is callable — guard here too:
      // a disabled agent won't heartbeat to consume the flag, so the request would just hang pending.
      if (agent.deletedAt) throw new HttpError(409, "agent is in the trash");
      if (!agent.enabled) throw new HttpError(409, "enable the runner before requesting an update");
      await db.agent.update({ where: { id: agentId }, data: { updateRequested: true, updateRequestedAt: new Date(), updateRequestedBy: actor, updateDeliveredAt: null } });
      await db.auditLog.create({ data: { actor, action: "agent.update_requested", detail: { agentId } } });
      return { id: agentId };
    },

    // Operator action: ask the runner to RESTART (re-exec, no file pull) on its next heartbeat — clears
    // a wedged claim/work loop remotely. Needs a supervised runner to come back cleanly.
    async requestRestart(agentId: string, actor = "ui"): Promise<{ id: string }> {
      const agent = await db.agent.findUnique({ where: { id: agentId }, select: { id: true, enabled: true, deletedAt: true } });
      if (!agent) throw new HttpError(404, "unknown agent");
      if (agent.deletedAt) throw new HttpError(409, "agent is in the trash");
      if (!agent.enabled) throw new HttpError(409, "enable the runner before requesting a restart");
      await db.agent.update({ where: { id: agentId }, data: { restartRequested: true, restartRequestedAt: new Date(), restartRequestedBy: actor, restartDeliveredAt: null } });
      await db.auditLog.create({ data: { actor, action: "agent.restart_requested", detail: { agentId } } });
      return { id: agentId };
    },

    // Atomically claim up to `batchSize` eligible api jobs for this agent.
    async claim(agentId: string, batchSize: number, version?: string | null): Promise<RunnerJob[]> {
      const agent = await db.agent.findUnique({ where: { id: agentId }, select: { id: true, clientId: true, enabled: true, version: true, capabilities: true, priority: true } });
      if (!agent) throw new HttpError(404, "unknown agent");
      if (!agent.enabled) throw new HttpError(403, "agent disabled");

      // Priority failover: stand by (claim nothing) while a STRICTLY higher-priority peer of the same
      // scope is online — a client's other agents for a client runner, the other central runners for the
      // central one. Equal priority load-balances (unchanged). When the primary stops heartbeating
      // (> ONLINE_MS), this backup starts claiming; the stale-lease reclaim below then re-queues the
      // primary's in-flight jobs so the backup can pick them up.
      const ONLINE_MS = 90_000;
      const onlinePeers = await db.agent.findMany({
        where: { enabled: true, deletedAt: null, id: { not: agent.id }, clientId: agent.clientId, lastSeenAt: { gt: new Date(Date.now() - ONLINE_MS) } },
        select: { priority: true },
      });
      if (shouldStandBy(agent.priority, onlinePeers.map((p) => p.priority))) return [];

      // Reclaim stale leases: a job dispatched long ago whose assigned agent is gone/stale/
      // disabled goes back to pending. Scoped to dead agents so a peer can't reset a live
      // agent's in-flight jobs (the live agent keeps lastSeenAt fresh via heartbeat). This runs
      // BEFORE the stale-code guard below: an outdated single-agent client must still recover its
      // OWN crashed leases (no peer/central runner will — host affinity keeps on-prem jobs here).
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

      // Reclaim WEDGED "running" jobs — ones that posted progress then went silent (the dispatched
      // reclaim above only covers "dispatched"; a job flips to "running" on its first progress post).
      // Keyed off the JOB's own progressAt, NOT the agent heartbeat (the agent identity is reused, so a
      // restarted runner keeps the heartbeat green while the worker that owned this job is dead).
      // Bounded: re-queue once, then FAIL — so a deterministically-hanging step (e.g. a stuck Exchange
      // mirror) can't loop forever; the case fails and an operator re-plans (or uses Stop).
      const progressCutoff = new Date(Date.now() - PROGRESS_STALE_MS);
      // A clock-skewed writer (seen after a runner-host recovery) can stamp progressAt HOURS in the
      // future — such a job never ages past the cutoff and wedges forever. Anything claiming to be
      // from the future (beyond small skew slack) is just as dead as anything stale.
      const futureSkew = new Date(Date.now() + 10 * 60 * 1000);
      const wedged = await db.job.findMany({
        where: {
          status: "running",
          OR: [
            { progressAt: { lt: progressCutoff } },
            { progressAt: { gt: futureSkew } },
            { progressAt: null, startedAt: { lt: progressCutoff } },
            { progressAt: null, startedAt: { gt: futureSkew } },
          ],
        },
        select: { id: true, request: true, caseRequestId: true, systemKey: true, case: { select: { serviceNowCaseNumber: true, client: { select: { name: true, restricted: true, notifyOverride: true } } } } },
      });
      for (const w of wedged) {
        const reclaims = Number((req(w) as { progressReclaims?: unknown }).progressReclaims ?? 0);
        if (reclaims >= MAX_PROGRESS_RECLAIMS) {
          // Auto-stop: mark it failed but TAG it (request.autoStopped) so the run report shows a distinct
          // "⏱ auto-stopped — no progress" warning rather than a generic failure. refreshCaseStatus then
          // advances the case (a failed step doesn't block independent siblings) — "move on + warn".
          await db.job.update({ where: { id: w.id }, data: { status: "failed", error: "auto-stopped: this step made no progress for 20 minutes after a re-run — treated as wedged (e.g. a hung vendor call). The case continued; re-run this step to retry.", request: { ...(req(w) as object), autoStopped: true } as Prisma.InputJsonValue, finishedAt: new Date(), oneTimePassword: null } });
          await db.auditLog.create({ data: { actor: "system", action: "job.progress.failed", jobId: w.id, caseRequestId: w.caseRequestId, detail: { reclaims, autoStopped: true } } });
          await refreshCaseStatus(db, w.caseRequestId);
          const who = `${w.case?.serviceNowCaseNumber ?? w.caseRequestId}${w.case?.client?.name ? ` (${w.case.client.name})` : ""}`;
          await fireNotification({ event: "autoStopped", title: `Auto-stopped (wedged): ${w.systemKey} — ${who}`, caseNumber: w.case?.serviceNowCaseNumber ?? null, clientName: w.case?.client?.name ?? null, restricted: w.case?.client?.restricted ?? false, override: parseClientOverride(w.case?.client?.notifyOverride), systemKey: w.systemKey, at: new Date().toISOString(), detail: "No progress for 20 minutes after a re-run — treated as wedged. The case continued; re-run to retry.", url: process.env.APP_PUBLIC_URL ? `${process.env.APP_PUBLIC_URL}/cases/${w.caseRequestId}` : null });
        } else {
          await db.job.update({ where: { id: w.id }, data: { status: "pending", assignedAgentId: null, request: { ...(req(w) as object), progressReclaims: reclaims + 1 } as Prisma.InputJsonValue } });
          await db.auditLog.create({ data: { actor: "system", action: "job.progress.reclaim", jobId: w.id, caseRequestId: w.caseRequestId, detail: { reclaims: reclaims + 1 } } });
        }
      }

      // STALE-CODE GUARD: never hand jobs to a runner that isn't on the current build. A half-landed
      // self-update can leave an OLD process alive (it predates the single-instance lock so it won't
      // self-evict) which would run jobs with stale modules in memory — the cause of executors
      // crashing on bugs that were already fixed. The claiming process sends its OWN build id
      // (race-free); fall back to the last heartbeat's version. A valid-hash mismatch -> claim nothing.
      const build = runnerBuildId();
      const running = (version && version.trim()) || agent.version || "";
      const validHash = /^[0-9a-f]{6,}$/.test(running);
      if (validHash && running !== build) {
        return []; // outdated runner — the run report shows "agent outdated" as the pending reason
      }

      // central runner (clientId null) sees all clients' api jobs; a client agent sees only
      // its own. Jobs on a failed/completed case are excluded so a dead case can't run more.
      // Host affinity + capability gate: the central (cloud) runner must NEVER claim on-prem systems
      // (the ActiveDirectory/RSAT module, ADSync) — those only work on a client-network agent. A client
      // agent claims its client's jobs, but an on-prem system is withheld unless the agent REPORTS it can
      // run it (its Coretelligent module loaded) — so a DC missing RSAT doesn't grab an AD job it would
      // hard-fail ("Invoke-CtgADOnboarding not recognized"); it stays pending with a clear reason. A
      // legacy (pre-1.31) agent reports nothing (caps null) → withholds nothing → old behavior preserved.
      const scope = agent.clientId ? { clientId: agent.clientId } : {};
      const caps = parseCapabilities(agent.capabilities);
      const onPremExclude = agent.clientId ? onPremExclusions(caps) : ALWAYS_ON_PREM_SYSTEMS;
      // Browser-automation gate (both central AND client agents): withhold browser-only systems (e.g.
      // spanning-force-sync) unless the agent reports the 'browser' capability (Node+Playwright installed).
      const excluded = [...new Set([...onPremExclude, ...browserExclusions(caps)])];
      const candidates = await db.job.findMany({
        where: {
          status: "pending",
          mode: "api",
          ...(excluded.length ? { systemKey: { notIn: excluded } } : {}),
          OR: [
            // Normal flow. Don't exclude a "failed" case: a failed step (e.g. egnyte) must NOT strand
            // an unrelated pending step (e.g. m365) whose own deps succeeded. Only "pending" jobs are
            // candidates and the per-job dependency gate (below) blocks any whose prerequisites didn't
            // succeed. "completed" is excluded (no pending work) and paused cases are held.
            { case: { status: { not: "completed" }, deletedAt: null, pausedAt: null, ...scope } },
            // "Run this step only": an operator-targeted job runs even though its case is paused (or
            // completed) — that pause is exactly what stops the rest of the run from cascading.
            { singleRun: true, case: { deletedAt: null, ...scope } },
          ],
        },
        orderBy: [{ caseRequestId: "asc" }, { sequence: "asc" }],
        select: { id: true, caseRequestId: true, systemKey: true, sequence: true, mode: true, status: true, singleRun: true, request: true, case: { select: { status: true } } },
      });
      if (candidates.length === 0) return [];

      // load all jobs of the candidate cases once, for the dependency gate
      const caseIds = [...new Set(candidates.map((c) => c.caseRequestId))];
      const allJobs = await db.job.findMany({
        where: { caseRequestId: { in: caseIds } },
        select: { id: true, caseRequestId: true, systemKey: true, sequence: true, mode: true, status: true, request: true },
      });
      // A FAILED step the operator ACCEPTED ("ignore warning — mark complete") resolves its run-log
      // outcome. Treat that step as satisfied for the dependency gate so its dependents proceed (e.g.
      // an accepted directory-sync failure stops blocking m365). Keyed by case+systemKey.
      const acceptedOutcomes = await db.runOutcome.findMany({
        where: { caseRequestId: { in: caseIds }, status: "failed", resolvedAt: { not: null } },
        select: { caseRequestId: true, systemKey: true },
      });
      const acceptedSet = new Set(acceptedOutcomes.map((o) => `${o.caseRequestId}|${o.systemKey}`));
      const lite = (j: { id: string; caseRequestId: string; systemKey: string; sequence: number; mode: JobLite["mode"]; status: JobLite["status"]; request: unknown }): JobLite => {
        const r = req(j) as { requiresApproval?: boolean; approved?: boolean; dependsOn?: unknown };
        const deps = Array.isArray(r.dependsOn) ? (r.dependsOn as unknown[]).filter((d): d is string => typeof d === "string") : null;
        const accepted = j.status === "failed" && acceptedSet.has(`${j.caseRequestId}|${j.systemKey}`);
        return { id: j.id, systemKey: j.systemKey, sequence: j.sequence, mode: j.mode, status: j.status, requiresApproval: Boolean(r.requiresApproval), approved: Boolean(r.approved), dependsOn: deps, accepted };
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
      const caseMeta = await db.caseRequest.findMany({ where: { id: { in: caseIds } }, select: { id: true, clientId: true, secretOverrides: true, client: { select: { parentId: true, runCloudOnOwnAgent: true } } } });
      const caseMetaById = new Map(caseMeta.map((c) => [c.id, c]));
      // Own-agent affinity: for the CENTRAL runner, a client that pins its work to its own agent
      // (runCloudOnOwnAgent) AND actually HAS one gets ALL its jobs skipped here — they wait for that
      // client's agent (same as on-prem jobs). Falls back to central when the client has no agent.
      let pinnedClientIds = new Set<string>();
      if (!agent.clientId) {
        const pinned = [...new Set(caseMeta.filter((c) => c.client?.runCloudOnOwnAgent).map((c) => c.clientId))];
        if (pinned.length) {
          const withAgent = await db.agent.findMany({ where: { clientId: { in: pinned }, scope: "client_network", enabled: true, deletedAt: null }, select: { clientId: true } });
          pinnedClientIds = new Set(withAgent.map((a) => a.clientId).filter((x): x is string => Boolean(x)));
        }
      }
      // Load the candidate clients' secrets AND their parents' (a child account inherits the parent's
      // Delinea refs for systems it inherits) so an inheriting case isn't wrongly skipped as "missing".
      const parentIds = [...new Set(caseMeta.map((c) => c.client?.parentId).filter((x): x is string => Boolean(x)))];
      const clientSecrets = await db.secret.findMany({ where: { clientId: { in: [...new Set([...caseMeta.map((c) => c.clientId), ...parentIds])] } }, select: { clientId: true, name: true, externalId: true } });
      const secretsByClient = new Map<string, Map<string, string | null>>();
      for (const s of clientSecrets) {
        const m = secretsByClient.get(s.clientId) ?? new Map<string, string | null>();
        m.set(s.name, s.externalId);
        secretsByClient.set(s.clientId, m);
      }
      // Setup-state gate (opt-in, AppSetting "setup_gate"): only when enforcing does the claim path
      // pay for the extra lookups — default mode adds zero queries here.
      const gate: SetupGatePolicy = { enforceTested: false, ...((await getAppSetting<Partial<SetupGatePolicy>>(db, SETUP_GATE_KEY)) ?? {}) };
      const latestTestByKey = new Map<string, "ok" | "fail" | "untested">();
      const attestedKeys = new Set<string>();
      if (gate.enforceTested) {
        const gateClientIds = [...new Set(caseMeta.map((c) => c.clientId))];
        const [gateTests, gateStates] = await Promise.all([
          db.connectionTest.findMany({
            where: { clientId: { in: gateClientIds } },
            select: { clientId: true, systemKey: true, status: true, finishedAt: true },
            orderBy: { finishedAt: "desc" },
          }),
          db.systemSetupState.findMany({ where: { clientId: { in: gateClientIds }, attestedAt: { not: null } }, select: { clientId: true, systemKey: true } }),
        ]);
        for (const t of gateTests) {
          const k = `${t.clientId}:${t.systemKey}`;
          if (!latestTestByKey.has(k)) latestTestByKey.set(k, t.status === "ok" ? "ok" : t.status === "fail" ? "fail" : "untested");
        }
        for (const s of gateStates) attestedKeys.add(`${s.clientId}:${s.systemKey}`);
      }

      const eligible: string[] = [];
      for (const c of candidates) {
        // A single-step job bypasses the dependency gate AND the terminal/paused-case exclusion
        // (it's an explicit, operator-confirmed run), but still honors the approval gate below and
        // the secret/host-affinity preflight. Everything else uses the normal claim rules.
        const lj = lite(c);
        const claimable = c.singleRun
          ? !(lj.requiresApproval && !lj.approved)
          : isClaimable(lj, byCase.get(c.caseRequestId) ?? [], c.case.status);
        if (!claimable) continue;
        // Host affinity — the on-prem / cloud split:
        //  - the CENTRAL runner can't run an on-prem step (only a hybrid case's exchange reaches here);
        //  - a CLIENT-network agent (on-prem box, e.g. a DC) can't run a CLOUD step — it doesn't have the
        //    Microsoft.Graph / EXO modules — so cloud steps go to the central runner, which does.
        // A client that pins cloud to its own agent (runCloudOnOwnAgent) is the exception on both sides.
        // Without this, an on-prem client agent grabs an M365 job it can't run ("Get-MgSubscribedSku not recognized").
        const meta = caseMetaById.get(c.caseRequestId);
        const onPrem = systemIsOnPrem(c.systemKey, hybridCases.has(c.caseRequestId));
        if (!agent.clientId && onPrem) continue;                                             // central: skip on-prem
        if (agent.clientId && !onPrem && !meta?.client?.runCloudOnOwnAgent) continue;        // client agent: skip cloud -> central
        // Own-agent affinity: central runner leaves a pinned client's cloud jobs for that client's agent.
        if (!agent.clientId && meta && pinnedClientIds.has(meta.clientId)) continue;
        const clientMap = (meta && secretsByClient.get(meta.clientId)) ?? new Map<string, string | null>();
        const parentMap = meta?.client?.parentId ? secretsByClient.get(meta.client.parentId) : undefined;
        if (missingRequiredSecrets(req(c).secretNames, meta?.secretOverrides, clientMap, parentMap).length > 0) continue; // secrets not set — skip
        // Setup-state gate (enforce mode only): withhold a job whose system's latest conn-test
        // failed, unless attested. singleRun bypasses (an explicit operator-confirmed run).
        if (gate.enforceTested && !c.singleRun && meta) {
          const k = `${meta.clientId}:${c.systemKey}`;
          const verdict = setupGateBlocks({ test: latestTestByKey.get(k) ?? "unknown", attested: attestedKeys.has(k) }, gate);
          if (verdict.block) continue;
        }
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

      // A case with a dispatched/running step IS running — reflect it now so the cases list shows
      // "running" instead of "queued" while work executes (status is only otherwise recomputed when a
      // job finishes). Only bump pre-execution states; never override a paused/needs_* hold.
      const runningCaseIds = [...new Set(claimed.map((c) => c.caseRequestId))];
      await db.caseRequest.updateMany({ where: { id: { in: runningCaseIds }, status: { in: ["queued", "planning"] } }, data: { status: "running" } });

      // AD email write-back (B1): for any ad-email-writeback job being handed out, resolve the
      // mailbox's ASSIGNED primary SMTP from the sibling cloud job's result (exchange preferred, then
      // m365) and inject it into the payload as `writebackEmail`, so the on-prem agent just writes AD
      // `mail` = that address without needing cloud creds. The executor falls back to the deterministic
      // workEmail/UPN when no result carries an address (e.g. an older runner that didn't return it).
      const writebackCaseIds = [...new Set(claimed.filter((j) => j.systemKey === "ad-email-writeback").map((j) => j.caseRequestId))];
      const emailByCase = new Map<string, string>();
      if (writebackCaseIds.length > 0) {
        const siblings = await db.job.findMany({
          where: { caseRequestId: { in: writebackCaseIds }, systemKey: { in: ["exchange", "m365"] }, status: "succeeded" },
          select: { caseRequestId: true, systemKey: true, result: true },
        });
        for (const s of siblings) {
          // The runner emits PascalCase result keys (PrimarySmtpAddress); tolerate lowercase too.
          const res = s.result as { PrimarySmtpAddress?: unknown; primarySmtpAddress?: unknown } | null;
          const addr = res?.PrimarySmtpAddress ?? res?.primarySmtpAddress;
          if (typeof addr === "string" && addr.includes("@")) {
            const cur = emailByCase.get(s.caseRequestId);
            if (!cur || s.systemKey === "exchange") emailByCase.set(s.caseRequestId, addr); // exchange wins over m365
          }
        }
      }

      // Offboard manager hand-off: exchange grants the departing user's MANAGER Full Access to the
      // converted shared mailbox (delegateManagerFullAccess). It normally runs first and reads the live
      // directory link — but if it runs AFTER active-directory (a re-run, or a first attempt that
      // failed), AD has already CLEARED that link and the delegate would be silently skipped. The AD
      // step captures the manager it cleared; inject that address so exchange can still grant access.
      const exchangeOffboardCaseIds = [
        ...new Set(claimed.filter((j) => j.systemKey === "exchange" && j.case.action === "offboard").map((j) => j.caseRequestId)),
      ];
      const managerByCase = new Map<string, string>();
      if (exchangeOffboardCaseIds.length > 0) {
        const adJobs = await db.job.findMany({
          where: { caseRequestId: { in: exchangeOffboardCaseIds }, systemKey: "active-directory", status: "succeeded" },
          select: { caseRequestId: true, result: true },
        });
        for (const a of adJobs) {
          // The runner emits PascalCase result keys (Manager.Email); tolerate lowercase too.
          const res = (a.result ?? {}) as { Manager?: unknown; manager?: unknown };
          const m = (res.Manager ?? res.manager) as { Email?: unknown; email?: unknown } | null;
          const addr = m?.Email ?? m?.email;
          if (typeof addr === "string" && addr.includes("@")) managerByCase.set(a.caseRequestId, addr);
        }
      }

      // AD consistency check (Design D, detect-only): inject the Entra object's anchor data (from the
      // m365 result) so the on-prem agent can compare it to the AD source anchor without cloud creds.
      const checkCaseIds = [...new Set(claimed.filter((j) => j.systemKey === "ad-consistency-check").map((j) => j.caseRequestId))];
      const cloudByCase = new Map<string, { immutableId: string | null; syncEnabled: boolean | null; userId: string | null }>();
      if (checkCaseIds.length > 0) {
        const m365s = await db.job.findMany({
          where: { caseRequestId: { in: checkCaseIds }, systemKey: { in: ["m365", "entra"] }, status: "succeeded" },
          select: { caseRequestId: true, result: true },
        });
        for (const s of m365s) {
          const res = (s.result ?? {}) as Record<string, unknown>;
          const pick = (a: string, b: string) => res[a] ?? res[b];
          const immutableId = pick("OnPremImmutableId", "onPremImmutableId");
          const syncEnabled = pick("OnPremSyncEnabled", "onPremSyncEnabled");
          const userId = pick("UserId", "userId");
          cloudByCase.set(s.caseRequestId, {
            immutableId: typeof immutableId === "string" ? immutableId : null,
            syncEnabled: typeof syncEnabled === "boolean" ? syncEnabled : null,
            userId: typeof userId === "string" ? userId : null,
          });
        }
      }

      // MAILBOX HAND-OFF (offboard): the m365/entra executor is the one that removes the license, and it
      // must NOT strip the license off a mailbox that was never converted to shared — Exchange purges an
      // unlicensed, unconverted mailbox after its 30-day grace, which loses the leaver's mail outright.
      // The Exchange step already computes the size and decides whether to convert; it just had nobody to
      // tell. Hand both facts to the downstream license step:
      //   mailboxSizeGB   — drives the executor's existing "keep the license over the threshold" rule,
      //                     which until now was DEAD: -MailboxSizeGB was never passed, so it was always 0.
      //   mailboxConverted— true only when the mailbox is actually shared now. The license removal is
      //                     gated on it, so a skipped conversion keeps the license instead of orphaning it.
      // Absent (Exchange hasn't run / isn't in the plan) => both undefined, and the executor keeps its
      // old behaviour, so a cloud-only client with no Exchange step is unaffected.
      const licenseCaseIds = [
        ...new Set(claimed.filter((j) => (j.systemKey === "m365" || j.systemKey === "entra") && j.case.action === "offboard").map((j) => j.caseRequestId)),
      ];
      const mailboxByCase = new Map<string, { sizeGB: number | null; converted: boolean; convertPending: boolean }>();
      if (licenseCaseIds.length > 0) {
        // EVERY exchange job on these cases, not just the finished ones — because the dangerous case is
        // the one that HASN'T run. Most clients' profiles put the licence removal in a step that runs
        // BEFORE exchange converts the mailbox (regal, six-one, yuma…). Ordering is per-client data and
        // will drift again; this guard does not depend on getting it right. If a conversion is CONFIGURED
        // and hasn't succeeded yet, the licence stays put and the step says so.
        const exJobs = await db.job.findMany({
          where: { caseRequestId: { in: licenseCaseIds }, systemKey: "exchange" },
          select: { caseRequestId: true, result: true, status: true, request: true },
        });
        for (const e of exJobs) {
          const res = (e.result ?? {}) as Record<string, unknown>;
          const raw = res.MailboxSizeGB ?? res.mailboxSizeGB;
          const sizeGB = typeof raw === "number" ? raw : null;
          // The executor reports the conversion in its action lines ("converted mailbox to shared…"), and
          // says so explicitly when it declines ("over threshold … kept as a user mailbox").
          const actions = (res.Actions ?? res.actions ?? []) as unknown[];
          const lines = actions.filter((a): a is string => typeof a === "string");
          const converted = lines.some((a) => /converted mailbox to shared|already a shared mailbox/i.test(a));
          // Does this client even ask for a conversion? If not, there is nothing to wait for.
          const exCfg = ((req(e).config ?? {}) as { convertToShared?: unknown }).convertToShared;
          const convertPending = exCfg != null && e.status !== "succeeded";
          mailboxByCase.set(e.caseRequestId, { sizeGB, converted, convertPending });
        }
      }

      // Generated INITIAL password (revealed once): for a "generate"-mode m365/entra onboard, generate
      // the password app-side so we can show it to the operator, store it on the case (revealed once,
      // then wiped), and inject it as the runner's initial password. Only when the runner WOULD generate
      // one anyway (no initialPasswordSecret, no literal, no brokered default-password) — never overrides
      // a wired/fixed password. Idempotent: reuse the stored value across re-claims.
      const pwByCase = new Map<string, string>();
      for (const j of claimed) {
        if (j.case.action !== "onboard" || (j.systemKey !== "m365" && j.systemKey !== "entra")) continue;
        if (pwByCase.has(j.caseRequestId)) continue;
        const rr = req(j);
        const cfg = (rr.config ?? {}) as { initialPasswordSecret?: unknown; initialPassword?: unknown };
        const generateMode = !cfg.initialPasswordSecret && !cfg.initialPassword && !((rr.secretNames ?? []).includes("default-password"));
        if (!generateMode) continue;
        let pw = (j.case as { initialPassword?: string | null }).initialPassword ?? null;
        if (!pw) {
          pw = generateInitialPassword();
          await db.caseRequest.update({ where: { id: j.caseRequestId }, data: { initialPassword: pw } });
        }
        pwByCase.set(j.caseRequestId, pw);
      }

      return claimed.map((j) => {
        const r = req(j);
        const injectedPw = (j.systemKey === "m365" || j.systemKey === "entra") ? pwByCase.get(j.caseRequestId) : undefined;
        let config = injectedPw ? { ...((r.config as Record<string, unknown> | null) ?? {}), initialPassword: injectedPw } : (r.config ?? null);
        // Ad-hoc password reset: hand the app-generated value (Job.oneTimePassword — revealed once to
        // the operator, then wiped) to the runner as config.newPassword. Kept on the row across
        // re-claims (lease reclaim) until the reveal/failure wipes it; never persisted into request.
        if (PASSWORD_RESET_SYSTEM_KEYS.includes(j.systemKey) && j.oneTimePassword) {
          config = { ...((config as Record<string, unknown> | null) ?? {}), newPassword: j.oneTimePassword };
        }
        // Mailbox facts from the Exchange step, so the license removal can honour "convert first".
        const mbx = (j.systemKey === "m365" || j.systemKey === "entra") && j.case.action === "offboard"
          ? mailboxByCase.get(j.caseRequestId)
          : undefined;
        if (mbx) {
          config = {
            ...((config as Record<string, unknown> | null) ?? {}),
            ...(mbx.sizeGB !== null ? { mailboxSizeGB: mbx.sizeGB } : {}),
            mailboxConverted: mbx.converted,
            mailboxConvertPending: mbx.convertPending,
          };
        }
        const casePayload = (j.case.payload ?? {}) as Record<string, unknown>;
        // Only fill a manager the intake didn't already carry — an operator-supplied address wins.
        const capturedManager =
          j.systemKey === "exchange" && j.case.action === "offboard" && !casePayload.managerEmail
            ? managerByCase.get(j.caseRequestId)
            : undefined;
        const payload =
          j.systemKey === "ad-email-writeback"
            ? { ...casePayload, writebackEmail: emailByCase.get(j.caseRequestId) ?? null }
            : j.systemKey === "ad-consistency-check"
            ? { ...casePayload, cloudObject: cloudByCase.get(j.caseRequestId) ?? { immutableId: null, syncEnabled: null, userId: null } }
            : capturedManager
            ? { ...casePayload, managerEmail: capturedManager }
            : j.case.payload;
        return {
          id: j.id,
          caseNumber: j.case.serviceNowCaseNumber ?? null,
          action: j.case.action,
          systemKey: j.systemKey,
          mode: j.mode,
          client: { slug: j.case.client.slug, primaryDomain: j.case.client.primaryDomain, backbone: j.case.client.backbone },
          config,
          secretNames: r.secretNames ?? [],
          payload,
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
    async brokerCredential(jobId: string, agentId: string, secretName: string, withOtp = false): Promise<BrokeredCredential> {
      const job = await db.job.findUnique({ where: { id: jobId }, select: { status: true, assignedAgentId: true, request: true, case: { select: { clientId: true, secretOverrides: true, client: { select: { parentId: true } } } } } });
      if (!job) throw new HttpError(404, "unknown job");
      if (job.assignedAgentId !== agentId) throw new HttpError(403, "job not assigned to this agent");
      await assertAgentEnabled(db, agentId);
      if (job.status !== "dispatched" && job.status !== "running") throw new HttpError(409, `job is ${job.status}; credentials only brokered for in-progress jobs`);
      // WHY a broker attempt failed, stamped on the Job so the run outcome can carry the structured
      // reason (recordResult copies it) — remediation is then scriptable off `code` + secretName.
      // Best-effort: stamping must never mask the real error. Cleared again on a clean broker.
      const stamp = async (cf: CredFailure | null) => {
        try { await db.job.update({ where: { id: jobId }, data: { credFailure: cf === null ? Prisma.DbNull : (cf as unknown as Prisma.InputJsonValue) } }); } catch { /* non-fatal */ }
      };
      const allowed = req(job).secretNames ?? [];
      if (!allowed.includes(secretName)) {
        await stamp(credFailure("not_authorized", secretName, `secret ${secretName} is not authorized for this job`));
        throw new HttpError(403, `secret ${secretName} is not authorized for this job`);
      }
      const clientSecret = await db.secret.findUnique({ where: { clientId_name: { clientId: job.case.clientId, name: secretName } }, select: { provider: true, externalId: true } });
      // Child accounts that run their parent's runbook also inherit the parent's Delinea references —
      // looked up only when the child has none of its own (the override/own ref take precedence).
      const parentId = job.case.client.parentId;
      const parentSecret = parentId && !clientSecret?.externalId
        ? await db.secret.findUnique({ where: { clientId_name: { clientId: parentId, name: secretName } }, select: { provider: true, externalId: true } })
        : null;
      // A per-case override wins over the child's own ref, which wins over the parent's; all Delinea ids.
      const { externalId, source } = effectiveExternalId(secretName, job.case.secretOverrides, clientSecret?.externalId ?? null, parentSecret?.externalId ?? null);
      if (source === "not_needed") {
        await stamp(credFailure("not_needed", secretName, "the secret is marked not-needed (manual step), yet the executor requested it"));
        throw new HttpError(409, `secret '${secretName}' is marked not needed (handled as a manual step) — no credential to broker`);
      }
      if (!externalId) {
        await stamp(credFailure("reference_missing", secretName, "no Delinea reference wired on the client, its parent, or a case override"));
        throw new HttpError(404, `no usable secret reference '${secretName}' (set it on the client or override it on the case)`);
      }
      // Overrides only replace the reference id, not the provider — every reference is a Delinea id.
      const secret = { provider: clientSecret?.provider ?? parentSecret?.provider ?? "delinea", externalId, source };

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
        if (!resolved.ok) {
          const why = resolved.error ?? "unknown error";
          await stamp(credFailure(classifyDelineaError(why), secretName, why, { externalId: secret.externalId, source: secret.source }));
          throw new HttpError(502, `secret '${secretName}' is not resolvable in Delinea: ${why}`);
        }
        brokered = true;
        label = resolved.label;
        fields = resolved.fields;
        note = undefined;
      } else {
        await stamp(credFailure("delinea_not_configured", secretName, "the app has no Delinea credentials — nothing can be resolved or pushed down"));
      }
      // One-time password, ON REQUEST only. Delinea holds the authenticator seed (one-time-password
      // enabled on the secret) and mints the current code; we never store or broker the SEED. The
      // code lives ~30s, so the runner asks for it at the moment it needs it — not at claim time —
      // and getOneTimePasswordCode waits out a nearly-dead window so it can't expire mid-login.
      let otpCode: string | undefined;
      let otpRemainingSeconds: number | undefined;
      let otpError: string | undefined;
      if (withOtp) {
        if (!delineaConfigured(cfg)) otpError = "Delinea not configured on the app";
        else {
          const otp = await getOneTimePasswordCode(cfg, secret.externalId);
          if (otp.ok) { otpCode = otp.code; otpRemainingSeconds = otp.remainingSeconds; }
          else otpError = otp.error;
        }
      }
      if (withOtp && otpError) {
        await stamp(credFailure("otp_unavailable", secretName, otpError, { externalId: secret.externalId, source: secret.source }));
      } else if (brokered) {
        // clean broker — clear any stale stamp from an earlier failed attempt so a later, unrelated
        // job failure isn't mislabeled as a credential problem
        await stamp(null);
      }
      // Audit records metadata ONLY — the field NAMES, never their values (and never the OTP).
      await db.auditLog.create({ data: { actor: `agent:${agentId}`, action: "job.credential", jobId, clientId: job.case.clientId, detail: { secretName, brokered, source: secret.source, fieldNames: fields ? Object.keys(fields) : [], ...(withOtp ? { otp: otpCode ? "minted" : `unavailable: ${otpError}` } : {}) } } });
      return { provider: secret.provider, externalId: secret.externalId, secretName, brokered, expiresInSeconds: 300, label, note, fields, otpCode, otpRemainingSeconds, otpError };
    },

    // --- Connection tests (isolated permission preflight) ----------------------------------------
    // A separate lane from the Job pipeline: the runner connects with the brokered credential and
    // does one cheap authorized read, proving the cred not only resolves but actually has access.
    // Routed like a job (cloud -> central runner, on-prem -> client agent) via the onPrem flag.

    // Queue a fresh set of tests for a client (replaces any prior run). One row per api system that
    // actually connects to something (has a required secret). With a systemKey, retests ONLY that
    // system — its row is replaced and every other system's latest result survives.
    // deepAllowed: caller states whether an INTERACTIVE probe (a real vendor-portal sign-in) is wanted.
    // Only the operator's explicit "test this one system" says yes — a save-and-test after editing a
    // token, a whole-client run, the fleet button and the nightly sweep all say no. See ConnectionTest.deep.
    async requestConnectionTests(clientSlug: string, systemKey?: string, source: "manual" | "sweep" = "manual", deepAllowed = false): Promise<{ tests: { systemKey: string; onPrem: boolean }[] }> {
      const client = await db.client.findUnique({
        where: { slug: clientSlug },
        select: { id: true, primaryDomain: true, systems: { select: { systemKey: true, mode: true, secretNames: true, config: true } }, secrets: { select: { name: true, externalId: true } } },
      });
      if (!client) throw new HttpError(404, `unknown client ${clientSlug}`);
      const hasAd = client.systems.some((s) => ALWAYS_ON_PREM_SYSTEMS.includes(s.systemKey));
      if (systemKey) {
        const target = client.systems.find((s) => s.systemKey === systemKey);
        if (!target) throw new HttpError(404, `client has no system '${systemKey}'`);
        if (target.mode !== "api" || (target.secretNames?.length ?? 0) === 0)
          throw new HttpError(422, `system '${systemKey}' has no connection to test (needs mode=api and at least one secret)`);
      }
      const specs = testableSystems(client.systems, hasAd, systemKey);
      await db.connectionTest.deleteMany({ where: { clientId: client.id, ...(systemKey ? { systemKey } : {}) } });
      if (specs.length === 0) return { tests: [] };
      // Retesting ONE system, by hand, is the only place a deep (interactive, browser) probe may run.
      const deep = Boolean(systemKey) && deepAllowed;
      const rows = specs.map((s) => connTestRow(client.id, s, client.secrets, source, deep));
      await db.connectionTest.createMany({ data: rows });
      // Stage 1 ("Fields"): the app's own Delinea resolve + field-shape check, persisted on the
      // rows. Best-effort — a preflight problem must never stop the runner stages from running.
      await preflightConnTestFields(db, client.id, client.primaryDomain, specs).catch(() => {});
      return { tests: rows.map((r) => ({ systemKey: r.systemKey, onPrem: r.onPrem })) };
    },

    // FLEET sweep: enqueue connection tests for every modeled, active client at once (one row per
    // testable api system). Replaces any prior run per client. Runners claim them on their next poll
    // — cloud tests on the central runner, on-prem on each client's own agent (so clients without an
    // installed agent leave their on-prem tests pending, surfaced as such in the roll-up). Returns
    // how many clients + tests were queued, and how many of those tests are on-prem.
    async requestConnectionTestsForAll(): Promise<{ clients: number; tests: number; onPrem: number }> {
      const clients = await db.client.findMany({
        where: { status: "active", systems: { some: {} } },
        select: { id: true, systems: { select: { systemKey: true, mode: true, secretNames: true, config: true } }, secrets: { select: { name: true, externalId: true } } },
      });
      let total = 0, onPrem = 0, withTests = 0;
      for (const client of clients) {
        const hasAd = client.systems.some((s) => ALWAYS_ON_PREM_SYSTEMS.includes(s.systemKey));
        const specs = testableSystems(client.systems, hasAd);
        await db.connectionTest.deleteMany({ where: { clientId: client.id } });
        if (specs.length === 0) continue;
        // Same row shape as the per-client path (optional secrets attached), but NEVER deep: a fleet
        // run must not fire an interactive M365 sign-in once per client, however it was triggered.
        const rows = specs.map((s) => connTestRow(client.id, s, client.secrets, "manual", false));
        await db.connectionTest.createMany({ data: rows });
        withTests++; total += rows.length; onPrem += rows.filter((r) => r.onPrem).length;
      }
      return { clients: withTests, tests: total, onPrem };
    },

    // Fleet roll-up: every connection-test result joined to its client, for the /health/connections page.
    async listAllConnectionTests() {
      const tests = await db.connectionTest.findMany({
        orderBy: [{ status: "asc" }, { clientId: "asc" }, { systemKey: "asc" }],
        select: { systemKey: true, status: true, detail: true, accessOk: true, accessDetail: true, fieldsOk: true, fieldsDetail: true, rights: true, credExpiresAt: true, source: true, onPrem: true, finishedAt: true, claimedAt: true, client: { select: { name: true, slug: true } } },
      });
      return tests;
    },

    async listConnectionTests(clientSlug: string) {
      const client = await db.client.findUnique({ where: { slug: clientSlug }, select: { id: true } });
      if (!client) throw new HttpError(404, `unknown client ${clientSlug}`);
      const tests = await db.connectionTest.findMany({
        where: { clientId: client.id },
        orderBy: { systemKey: "asc" },
        select: { systemKey: true, status: true, detail: true, accessOk: true, accessDetail: true, fieldsOk: true, fieldsDetail: true, rights: true, credExpiresAt: true, onPrem: true, finishedAt: true },
      });
      return { tests };
    },

    // Atomic claim, same scope rule as job claim: a central runner (no clientId) takes only cloud
    // tests; a client agent takes its own client's (cloud + on-prem).
    async claimConnectionTests(agentId: string, max = 5): Promise<{ id: string; systemKey: string; secretNames: string[]; clientSlug: string; primaryDomain: string; config: unknown; deep: boolean }[]> {
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
        select: { id: true, systemKey: true, secretNames: true, optionalSecretNames: true, config: true, deep: true, client: { select: { slug: true, primaryDomain: true } } },
      });
      // `deep` travels to the runner so an interactive probe (a real browser sign-in) runs ONLY on a
      // targeted single-system retest. There is deliberately no capability gate on the claim itself:
      // withholding the test from a browser-less agent would take the ordinary API check down with it.
      // The runner reports "browser not available on this agent" as an unverified rights row instead.
      return claimed.map((t) => ({ id: t.id, systemKey: t.systemKey, secretNames: t.secretNames, optionalSecretNames: t.optionalSecretNames, clientSlug: t.client.slug, primaryDomain: t.client.primaryDomain, config: t.config ?? null, deep: t.deep }));
    },

    // Same push-down broker as a job, scoped to the test's own secretNames (no case overrides).
    // withOtp mints a CURRENT Delinea one-time password, mirroring the job path: a deep probe signs in
    // to a vendor portal for real, and its MFA code must be minted AT the prompt (a 30s TOTP cannot
    // survive browser launch + the SSO hop). The authenticator seed stays in the vault; we only ever
    // hold a code. Authorization is unchanged — the secret must still be one of the test's own.
    async brokerConnectionTestCredential(testId: string, agentId: string, secretName: string, withOtp = false): Promise<BrokeredCredential> {
      const t = await db.connectionTest.findUnique({ where: { id: testId }, select: { status: true, assignedAgentId: true, secretNames: true, optionalSecretNames: true, deep: true, clientId: true } });
      if (!t) throw new HttpError(404, "unknown connection test");
      if (t.assignedAgentId !== agentId) throw new HttpError(403, "connection test not assigned to this agent");
      await assertAgentEnabled(db, agentId);
      if (t.status !== "running") throw new HttpError(409, `connection test is ${t.status}; credentials only brokered while running`);
      if (!t.secretNames.includes(secretName) && !t.optionalSecretNames.includes(secretName)) throw new HttpError(403, `secret ${secretName} is not authorized for this connection test`);
      // Minting a live MFA code is only ever legitimate for an interactive probe, which only a deep
      // test runs. Enforce that HERE rather than trusting the runner to ask nicely: a bug (or a
      // compromised agent) must not be able to pull one-time passwords out of the vault on a routine
      // sweep. This is the server's own check, independent of anything the caller claims.
      if (withOtp && !t.deep) throw new HttpError(403, "a one-time password is only brokered for a deep (interactive) connection test");
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
      let otpCode: string | undefined;
      let otpRemainingSeconds: number | undefined;
      let otpError: string | undefined;
      if (withOtp) {
        if (!delineaConfigured(cfg)) otpError = "Delinea not configured on the app";
        else {
          const otp = await getOneTimePasswordCode(cfg, externalId);
          if (otp.ok) { otpCode = otp.code; otpRemainingSeconds = otp.remainingSeconds; }
          else otpError = otp.error;
        }
      }
      // Metadata ONLY — field NAMES, never values, and never the OTP itself.
      await db.auditLog.create({ data: { actor: `agent:${agentId}`, action: "conntest.credential", clientId: t.clientId, detail: { secretName, brokered, fieldNames: fields ? Object.keys(fields) : [], ...(withOtp ? { otp: otpCode ? "minted" : `unavailable: ${otpError}` } : {}) } } });
      return { provider: clientSecret?.provider ?? "delinea", externalId, secretName, brokered, expiresInSeconds: 300, label, note, fields, otpCode, otpRemainingSeconds, otpError };
    },

    async reportConnectionTest(
      testId: string,
      agentId: string,
      ok: boolean,
      detail: string,
      accessOk: boolean | null = null,
      accessDetail: string | null = null,
      rights: RightsRow[] | null = null,
      credExpiresAt: Date | null = null
    ): Promise<{ ok: true }> {
      const t = await db.connectionTest.findUnique({ where: { id: testId }, select: { assignedAgentId: true, clientId: true, systemKey: true, source: true } });
      if (!t) throw new HttpError(404, "unknown connection test");
      if (t.assignedAgentId !== agentId) throw new HttpError(403, "connection test not assigned to this agent");
      // Overall status is a fail if EITHER stage failed (access couldn't resolve, or the API read failed).
      const passed = accessOk !== false && ok;
      const finishedAt = new Date();
      const trimmedDetail = (detail ?? "").slice(0, 500);
      await db.connectionTest.update({
        where: { id: testId },
        data: {
          status: passed ? "ok" : "fail",
          detail: trimmedDetail,
          accessOk,
          accessDetail: accessDetail === null ? null : accessDetail.slice(0, 500),
          // Optional extras from newer runners: per-operation rights rows + the credential's own
          // expiry when the probe could read it. Null-tolerant so older runners keep working.
          ...(rights ? { rights: rights as unknown as Prisma.InputJsonValue } : {}),
          ...(credExpiresAt ? { credExpiresAt } : {}),
          finishedAt,
        },
      });
      // Durable per-(client, system) health snapshot — ConnectionTest rows are deleted per run, so
      // new-failure detection and notification suppression live here. Only SWEEP-sourced new
      // failures queue a notification (the operator watches manual runs in the panel).
      try {
        const key = { clientId: t.clientId, systemKey: t.systemKey };
        const prev = await db.connHealthState.findUnique({ where: { clientId_systemKey: key }, select: { lastStatus: true } });
        const outcome = diffConnOutcome(prev, { passed });
        const common = {
          lastStatus: passed ? "ok" : "fail",
          lastDetail: trimmedDetail || null,
          ...(passed ? { lastOkAt: finishedAt } : { lastFailAt: finishedAt }),
          ...(credExpiresAt ? { credExpiresAt } : {}),
          ...(outcome === "new_failure" && t.source === "sweep" ? { pendingNotifyAt: finishedAt } : {}),
          ...(outcome === "recovered" ? { failNotifiedAt: null, pendingNotifyAt: null } : {}),
        };
        await db.connHealthState.upsert({ where: { clientId_systemKey: key }, update: common, create: { ...key, ...common } });
      } catch {
        // the snapshot is best-effort — never fail the result post over it
      }
      await db.auditLog.create({ data: { actor: `agent:${agentId}`, action: "conntest.result", clientId: t.clientId, detail: { systemKey: t.systemKey, accessOk, apiOk: ok, rightsMissing: rights ? rights.filter((r) => r.ok === false).length : undefined } } });
      return { ok: true };
    },

    // --- Cloud (Entra) group discovery -----------------------------------------------------------
    // Pull the tenant's groups (DLs / Security / M365 Groups) via the m365-admin secret so the group
    // pickers can offer cloud groups AD sync never sees. Like AD discovery (a request flag + a result
    // blob on the client), but claimed by the CENTRAL runner — it's the one with Graph.

    async requestCloudGroupDiscovery(clientSlug: string): Promise<{ ok: true }> {
      const client = await db.client.findUnique({
        where: { slug: clientSlug },
        select: { id: true, systems: { where: { systemKey: "m365" }, select: { secretNames: true } } },
      });
      if (!client) throw new HttpError(404, `unknown client ${clientSlug}`);
      if (client.systems.length === 0) throw new HttpError(422, "this client has no m365 system to read groups from");
      await db.client.update({ where: { id: client.id }, data: { cloudGroupsRequestedAt: new Date() } });
      return { ok: true };
    },

    // Central runner only. Claim every pending request, resolve its m365 secret(s) inline (push-down),
    // and clear the flag so it isn't claimed twice. Returns enough for the runner to connect + read.
    async claimCloudGroupDiscovery(agentId: string): Promise<{ clientSlug: string; primaryDomain: string; creds: Record<string, { fields?: Record<string, string>; note?: string }> }[]> {
      const agent = await db.agent.findUnique({ where: { id: agentId }, select: { enabled: true, clientId: true } });
      if (!agent) throw new HttpError(404, "unknown agent");
      if (!agent.enabled || agent.clientId) return []; // cloud groups come from the central (cloud) runner
      const pending = await db.client.findMany({
        where: { cloudGroupsRequestedAt: { not: null }, systems: { some: { systemKey: "m365" } } },
        select: { id: true, slug: true, primaryDomain: true, systems: { where: { systemKey: "m365" }, select: { secretNames: true } } },
        take: 5,
      });
      if (pending.length === 0) return [];
      // Claim: clear the flag now (so a second central runner won't re-claim). The runner reports back.
      await db.client.updateMany({ where: { id: { in: pending.map((c) => c.id) } }, data: { cloudGroupsRequestedAt: null } });
      const cfg = delineaConfigFromEnv();
      const out = [];
      for (const c of pending) {
        const names = c.systems[0]?.secretNames ?? [];
        const creds: Record<string, { fields?: Record<string, string>; note?: string }> = {};
        for (const name of names) {
          const sec = await db.secret.findUnique({ where: { clientId_name: { clientId: c.id, name } }, select: { externalId: true } });
          const { externalId } = effectiveExternalId(name, null, sec?.externalId ?? null);
          if (!externalId) { creds[name] = { note: "no usable secret reference" }; continue; }
          if (!delineaConfigured(cfg)) { creds[name] = { note: "Delinea not configured on the app" }; continue; }
          const resolved = await resolveSecretFields(cfg, externalId);
          creds[name] = resolved.ok ? { fields: resolved.fields } : { note: resolved.error ?? "unresolved" };
        }
        out.push({ clientSlug: c.slug, primaryDomain: c.primaryDomain, creds });
      }
      await db.auditLog.create({ data: { actor: `agent:${agentId}`, action: "cloudgroups.claim", detail: { clients: pending.map((c) => c.slug) } } });
      return out;
    },

    async reportCloudGroups(agentId: string, clientSlug: string, groups: { name: string; type: string }[]): Promise<{ ok: true; count: number }> {
      const agent = await db.agent.findUnique({ where: { id: agentId }, select: { enabled: true, clientId: true } });
      if (!agent || !agent.enabled) throw new HttpError(403, "unknown or disabled agent");
      // Only the central (cloud) runner discovers cloud groups — mirror claimCloudGroupDiscovery. A
      // client-network agent must not be able to write another client's group picker (cross-client write).
      if (agent.clientId) throw new HttpError(403, "only the central runner reports cloud groups");
      const client = await db.client.findUnique({ where: { slug: clientSlug }, select: { id: true } });
      if (!client) throw new HttpError(404, `unknown client ${clientSlug}`);
      // Normalize + cap (a big tenant can have thousands) so the picker payload stays sane.
      const clean = groups
        .filter((g) => g && typeof g.name === "string" && g.name.trim())
        .map((g) => ({ name: g.name.trim(), type: ["dl", "security", "m365"].includes(g.type) ? g.type : "security" }))
        .slice(0, 5000);
      await db.client.update({ where: { id: client.id }, data: { cloudGroups: { groups: clean, discoveredAt: new Date().toISOString() } } });
      await db.auditLog.create({ data: { actor: `agent:${agentId}`, action: "cloudgroups.result", clientId: client.id, detail: { count: clean.length } } });
      return { ok: true, count: clean.length };
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
      // progressAt = the queryable "still working?" signal (the JSON trail can't be filtered on) — the
      // reclaim/stuck logic keys off this, NOT the agent heartbeat (the agent identity is reused, so a
      // restarted runner keeps the heartbeat green while the worker that owned THIS job is dead).
      await db.job.update({ where: { id: jobId }, data: { progress: next as Prisma.InputJsonValue, status: "running", progressAt: new Date() } });
      // A runner mid-step posts progress every second or two, but only the between-jobs heartbeat
      // loop refreshes lastSeenAt — so a long step (an Exchange mailbox/DL mirror can run minutes)
      // would read "offline" while it's actively working. Treat a progress post as a heartbeat too:
      // a runner that's narrating its work IS alive. It now reads offline only when GENUINELY stuck
      // (no progress for the offline window) — which is the alarm we actually want.
      await db.agent.update({ where: { id: agentId }, data: { lastSeenAt: new Date() } });
      return { ok: true };
    },

    // Operator "Stop": abort an in-flight (or queued) step that looks wedged — mark it failed so the
    // case stops waiting on it (and its still-pending siblings are cancelled). A late result the runner
    // eventually posts is rejected by recordResult's terminal guard (409), so the Stop holds.
    async stopJob(jobId: string, actor: string): Promise<{ jobId: string; status: string; caseStatus: string }> {
      const job = await db.job.findUnique({ where: { id: jobId }, select: { status: true, caseRequestId: true, systemKey: true, case: { select: { clientId: true } } } });
      if (!job) throw new HttpError(404, "unknown job");
      if (!["pending", "dispatched", "running"].includes(job.status)) {
        throw new HttpError(409, `job is ${job.status} — only an in-flight or queued step can be stopped`);
      }
      const who = actor.startsWith("user:") ? actor.slice(5) : "an operator";
      // oneTimePassword: a stopped password reset may or may not have landed — the value is unverified,
      // so wipe it (same as a failed result); null is a no-op for every other job type.
      await db.job.update({ where: { id: jobId }, data: { status: "failed", error: `stopped by ${who} — the step was not progressing`, finishedAt: new Date(), oneTimePassword: null } });
      const caseStatus = await refreshCaseStatus(db, job.caseRequestId);
      await db.auditLog.create({ data: { actor, action: "job.stop", jobId, caseRequestId: job.caseRequestId, clientId: job.case.clientId, detail: { systemKey: job.systemKey } } });
      // Operator stops bypass recordResult (the runner never posts a result), so without this the
      // stopped step never reaches the /runs log. Never fatal to the stop itself.
      try {
        const full = await db.caseRequest.findUnique({ where: { id: job.caseRequestId }, select: { serviceNowCaseNumber: true, action: true, clientId: true, client: { select: { name: true } } } });
        if (full) {
          const error = `stopped by ${who} — the step was not progressing`;
          const fingerprint = outcomeFingerprint({ caseRequestId: job.caseRequestId, systemKey: job.systemKey, verdict: "failed", messages: [], error });
          await db.runOutcome.create({ data: {
            caseRequestId: job.caseRequestId, caseNumber: full.serviceNowCaseNumber ?? job.caseRequestId, action: full.action,
            clientId: full.clientId, clientName: full.client.name, systemKey: job.systemKey,
            verdict: "failed", status: "failed", messages: [], error, fingerprint,
          } });
        }
      } catch { /* outcome logging must not fail the stop */ }
      return { jobId, status: "failed", caseStatus };
    },

    // Record a job result, advance the case, audit, and queue a work note. The posting agent
    // must own the job; a repeat of the same terminal result is an idempotent no-op.
    async recordResult(jobId: string, agentId: string, input: ResultInput): Promise<{ jobId: string; status: string; caseStatus: string }> {
      const job = await db.job.findUnique({ where: { id: jobId }, select: { status: true, caseRequestId: true, systemKey: true, assignedAgentId: true, singleRun: true, request: true, credFailure: true, case: { select: { clientId: true, serviceNowCaseNumber: true, action: true, client: { select: { name: true, restricted: true, notifyOverride: true } } } } } });
      if (!job) throw new HttpError(404, "unknown job");
      if (job.assignedAgentId !== agentId) throw new HttpError(403, "job not assigned to this agent");
      await assertAgentEnabled(db, agentId);

      // OFFBOARD TARGET AMBIGUITY. An executor that cannot tell WHICH person to offboard (the name on
      // the ticket matched several users, or none) returns the shortlist it found rather than acting.
      // Such a result must NEVER be recorded as a success: it used to come back 'ok' with a WARN, which
      // let the case march to "completed" with the account still live. Force it to a decision: the step
      // fails with a DECISION_NEEDED marker (the same convention the username-collision flow uses), and
      // the case is HELD so an operator picks the right user and re-runs. The candidates ride along in
      // Job.result for the picker to render.
      const candidates = offboardCandidatesOf(input.result);
      const needsTargetDecision = input.status === "succeeded" && candidates.length > 0 && job.case.action === "offboard";

      const status = needsTargetDecision ? "failed" : input.status === "succeeded" ? "succeeded" : input.status === "skipped" ? "skipped" : "failed";
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
        data: {
          status, result: (input.result ?? undefined) as Prisma.InputJsonValue | undefined, evidence: (input.evidence ?? undefined) as Prisma.InputJsonValue | undefined, validation: (input.validation ?? undefined) as Prisma.InputJsonValue | undefined,
          error: needsTargetDecision ? offboardDecisionError(input.result, candidates.length) : (input.error ?? null),
          finishedAt: new Date(), singleRun: false,
          // A password reset that didn't land never shows its value — wipe it so a plaintext that was
          // never set on the account can't linger (a succeeded reset keeps it until the one-time reveal).
          ...(PASSWORD_RESET_SYSTEM_KEYS.includes(job.systemKey) && status !== "succeeded" ? { oneTimePassword: null } : {}),
        },
      });

      const isAdhoc = ADHOC_SYSTEM_KEYS.includes(job.systemKey);
      // AUTO-RETRY: a succeeded result carrying RetryAfterMinutes (e.g. Spanning/Mimecast "user not
      // discovered yet") schedules its own re-run; sweepAutoRetries re-queues it when due. A result
      // WITHOUT the marker clears any schedule (the wait is over) and audits the elapsed time. This
      // runs for the normal cascade AND for an ad-hoc singleRun action whose result says "queued, not
      // done" (the force-sync's promised re-poll) — but NOT for a plain "run this step only" of a
      // normal step, which intentionally doesn't reschedule.
      // Set when THIS result scheduled another wait: the step is benignly "retrying", not broken, so
      // it must not raise a chat alert or a run-log warning line (see the notify + outcome blocks
      // below). An EXHAUSTED retry is the opposite — the wait is over and it never resolved, so it
      // falls through as a normal warning and the operator finally sees it.
      let retryScheduled = false;
      if (status === "succeeded" && !req(job).validateOnly && (!job.singleRun || isAdhoc)) {
        const marker = (input.result ?? {}) as { RetryAfterMinutes?: unknown; retryAfterMinutes?: unknown };
        const mins = Number(marker.RetryAfterMinutes ?? marker.retryAfterMinutes ?? 0);
        const reqJson = { ...(job.request as Record<string, unknown> ?? {}) };
        const decision = decideAutoRetry((reqJson.autoRetry ?? null) as AutoRetryMarker | null, mins, Date.now());
        if (decision.kind === "scheduled") {
          reqJson.autoRetry = decision.marker;
          await db.job.update({ where: { id: jobId }, data: { request: reqJson as Prisma.InputJsonValue } });
          retryScheduled = true;
        } else if (decision.kind !== "none") {
          delete reqJson.autoRetry;
          await db.job.update({ where: { id: jobId }, data: { request: reqJson as Prisma.InputJsonValue } });
          // "exhausted" = we gave up: the vendor never caught up. Usually because the upstream work
          // never really landed (an M365 user created UNLICENSED has no mailbox, so Spanning/Mimecast
          // will never discover them — waiting longer cannot help). It now falls through as a warning.
          const action = decision.kind === "resolved" ? "job.autoretry.resolved" : "job.autoretry.exhausted";
          await db.auditLog.create({ data: { actor: "system:auto-retry", action, jobId, caseRequestId: job.caseRequestId, detail: { attempts: decision.attempts, elapsedMinutes: decision.elapsedMinutes } } });
        }
      }

      // "Run this step only" (and ad-hoc actions) record the outcome but do NOT cascade the CASE — no
      // case-status advance, no auto-verify sweep. The case stays paused; the operator resumes to
      // continue the normal run. (The shared outcome log + work-note below still run for both paths.)
      let caseStatus: string;
      if (job.singleRun) {
        const cs = await db.caseRequest.findUnique({ where: { id: job.caseRequestId }, select: { status: true } });
        caseStatus = cs?.status ?? "unknown";
      } else {
      const caseJobs = await db.job.findMany({ where: { caseRequestId: job.caseRequestId }, select: { id: true, systemKey: true, sequence: true, mode: true, status: true, request: true } });
      caseStatus = deriveCaseStatus(caseJobs.map((j) => ({ id: j.id, systemKey: j.systemKey, sequence: j.sequence, mode: j.mode, status: j.status, requiresApproval: Boolean(req(j).requiresApproval), approved: Boolean(req(j).approved) })));
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
            const sweep = caseJobs.filter((j) => j.mode === "api" && j.status === "succeeded" && !["servicenow", "case-resolution", ...ADHOC_SYSTEM_KEYS].includes(j.systemKey));
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
      await db.caseRequest.update({ where: { id: job.caseRequestId }, data: { status: caseStatus as CaseStatus } });
      } // end normal (non-single-step) cascade

      // HOLD the case on an unresolved offboard target. This is the ONE place a runner RESULT can pause
      // a case (everything else that holds does so at import/plan time) — without it the operator would
      // have to notice a failed step, rather than the case telling them it needs a decision. Held even
      // for a single-step run: whoever picks the user is choosing who gets locked out.
      if (needsTargetDecision) {
        await db.caseRequest.update({
          where: { id: job.caseRequestId },
          data: { pausedAt: new Date(), pausedReason: "needs_info", scheduledFor: null },
        });
        await db.auditLog.create({
          data: { actor: "system", action: "case.offboard_target.ambiguous", jobId, caseRequestId: job.caseRequestId, clientId: job.case.clientId, detail: { systemKey: job.systemKey, candidates: candidates.length, query: offboardCandidateQuery(input.result) } },
        });
      }

      await db.auditLog.create({ data: { actor: `agent:${job.assignedAgentId ?? "unknown"}`, action: job.singleRun ? "job.result.single" : "job.result", jobId, caseRequestId: job.caseRequestId, clientId: job.case.clientId, detail: { status, error: input.error ?? null } } });

      // The run-report verdict for THIS result: "failed", or "warning" when the step succeeded but its
      // validation read-back missed. Computed once here and reused by both the notify block below and
      // the outcome log — a warning is a real problem an operator must see, so it notifies too.
      const { verdict, messages } = jobOutcome(status, input.result, input.validation, input.error ?? null);

      // Failure notifications — best-effort + awaited (the sender is timeout-bounded, so it can't hang
      // the result path). Step-level alerts (failed/warning) fire for single-step re-runs too — a re-run
      // is the usual way an operator retries a broken step, and its failure must not go silent. Only the
      // normal cascade produces a meaningful new CASE status, so case-level alerts stay gated on it.
      {
        const caseNumber = job.case.serviceNowCaseNumber;
        const clientName = job.case.client?.name ?? null;
        const restricted = job.case.client?.restricted ?? false;
        const override = parseClientOverride(job.case.client?.notifyOverride);
        const url = process.env.APP_PUBLIC_URL ? `${process.env.APP_PUBLIC_URL}/cases/${job.caseRequestId}` : null;
        const who = `${caseNumber ?? job.caseRequestId}${clientName ? ` (${clientName})` : ""}`;
        // Who kicked off the run that led here — the most recent operator "run" action on this case
        // (resume/re-run/verify/import). Null when auth is off or the case ran unattended.
        const runAudit = await db.auditLog.findFirst({
          where: { caseRequestId: job.caseRequestId, action: { in: ["case.plan", "job.rerun", "case.verify", "case.resume", "case.dry_run.set"] }, actor: { startsWith: "user:" } },
          orderBy: { at: "desc" },
          select: { actor: true },
        });
        const actor = runAudit?.actor ? runAudit.actor.replace(/^user:/, "") : null;
        const at = new Date().toISOString();
        if (status === "failed") {
          await fireNotification({ event: "stepFailed", title: `Step failed: ${job.systemKey} — ${who}`, caseNumber, clientName, restricted, override, systemKey: job.systemKey, actor, at, detail: input.error ?? null, url });
        } else if (verdict === "warning" && !retryScheduled) {
          // Succeeded, but the read-back didn't confirm the change. Surfaced on /runs — now in chat too.
          // NOT while a retry is scheduled: the step is deliberately waiting on a vendor sync it told us
          // to wait for, so its "miss" is expected. Alerting there cried wolf every 15 minutes for a
          // step that self-heals. If the retries run out, the wait is over and this fires for real.
          await fireNotification({ event: "stepWarning", title: `Step warning: ${job.systemKey} — ${who}`, caseNumber, clientName, restricted, override, systemKey: job.systemKey, actor, at, detail: messages.length ? messages.join("\n") : "The step reported success but its validation read-back did not confirm the change.", url });
        }
        // Case-level alerts only make sense off the normal cascade (a single-step re-run doesn't
        // recompute a meaningful case status).
        if (!job.singleRun) {
          if (caseStatus === "failed") {
            await fireNotification({ event: "caseFailed", title: `Case failed: ${who}`, caseNumber, clientName, restricted, override, systemKey: job.systemKey, actor, at, detail: input.error ?? null, url });
          } else if (caseStatus === "needs_approval") {
            await fireNotification({ event: "needsApproval", title: `Case needs approval: ${who}`, caseNumber, clientName, restricted, override, actor, at, detail: "A destructive offboard step is waiting for approval.", url });
          }
        }
      }

      // Append-only outcome log: capture this run's success/warning/error per module, with the case
      // number + client + messages, so module problems can be tracked across cases (a re-run
      // overwrites the Job, but each result still lands here). Never fatal to result recording.
      //
      // A step that scheduled its own retry writes NO row: it is waiting on a vendor sync, exactly as
      // designed, and the run report already shows it as "retrying" (run-report.ts). Logging it filled
      // /runs with "validation missed: <vendor> user present" lines for steps that were about to fix
      // themselves — one per attempt, every 15 minutes. When the retries are exhausted the wait is
      // over, retryScheduled is false, and the (now genuine) warning is logged.
      if (!retryScheduled) try {
        const fingerprint = outcomeFingerprint({ caseRequestId: job.caseRequestId, systemKey: job.systemKey, verdict, messages, error: input.error ?? null });
        // If this exact line for this case was already marked "Fixed", inherit that resolution so a
        // re-run of an already-handled noise line doesn't reappear (a genuinely new error has a new
        // fingerprint and won't match).
        const prior = await db.runOutcome.findFirst({ where: { fingerprint, resolvedAt: { not: null } }, select: { resolvedAt: true, resolvedBy: true } });
        await db.runOutcome.create({
          data: {
            caseRequestId: job.caseRequestId,
            caseNumber: job.case.serviceNowCaseNumber ?? job.caseRequestId,
            action: job.case.action,
            clientId: job.case.clientId,
            clientName: job.case.client.name,
            systemKey: job.systemKey,
            verdict, status, messages,
            error: input.error ?? null,
            validateOnly: Boolean(req(job).validateOnly),
            // The broker's structured "why the credential failed" rides along on problem rows only —
            // /runs and remediation scripts key off credFailure.code instead of parsing error text.
            ...(job.credFailure && (verdict === "failed" || verdict === "warning")
              ? { credFailure: job.credFailure as Prisma.InputJsonValue }
              : {}),
            fingerprint,
            resolvedAt: prior?.resolvedAt ?? null,
            resolvedBy: prior?.resolvedBy ?? null,
          },
        });
      } catch { /* an outcome-log failure must never lose the job result */ }
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
