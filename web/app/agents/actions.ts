"use server";
// Operator-side agent management. Server actions call the service directly (server-side),
// so the UI doesn't hit — or need a token for — the runner-gated /api/agents endpoint.
import type { AgentScope } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { makeRunnerService } from "@/lib/jobs/runner-service";
import { HttpError } from "@/lib/jobs/types";
import { mintEnrollToken, enrollSecret } from "@/lib/runner/enroll-token";
import { requirePermission, AuthError } from "@/lib/auth/guard";
import { recordAudit, auditActor, type AuditActor } from "@/lib/auth/audit";
import { runnerBuildId } from "@/lib/runner/bundle";
import { getAppSetting, setAppSetting } from "@/lib/settings";
import { AGENT_MIGRATION_KEY, type AgentMigrationSetting } from "@/lib/jobs/agent-migration";

// Mint a short-lived enroll token for the one-line installer (scope/client bound into the token).
export async function createEnrollToken(input: { scope: AgentScope; clientSlug: string | null }) {
  let me;
  try { me = await requirePermission("agent.manage"); } catch (e) { return { ok: false as const, error: errMsg(e) }; }
  const slug = input.clientSlug?.trim() || null; // trim — a stray space breaks the client lookup
  if (input.scope === "client_network" && !slug) {
    return { ok: false as const, error: "pick a client for a client-network runner" };
  }
  const token = mintEnrollToken(
    { scope: input.scope, client: input.scope === "client_network" ? slug : null },
    enrollSecret(),
    Date.now()
  );
  // The later agent.enroll row is written when the runner calls in (actor "system"), so this is the only
  // record of WHO authorized an enrollment. The token is a credential — never audit its value.
  const client = slug ? await db.client.findUnique({ where: { slug }, select: { id: true } }) : null;
  await recordAudit("agent.enroll_token.create", { user: me, clientId: client?.id ?? null, detail: { scope: input.scope, clientSlug: slug } });
  return { ok: true as const, token };
}

const errMsg = (e: unknown) => (e instanceof AuthError ? e.message : e instanceof HttpError ? e.message : "internal error");

export async function enrollAgent(input: { name: string; scope: AgentScope; clientSlug?: string | null }) {
  try {
    await requirePermission("agent.manage");
    const out = await makeRunnerService(db).enroll(input);
    revalidatePath("/agents");
    return { ok: true as const, ...out };
  } catch (e) {
    return { ok: false as const, error: errMsg(e) };
  }
}

export async function setAgentEnabled(id: string, enabled: boolean) {
  try {
    const me = await requirePermission("agent.manage");
    await makeRunnerService(db).setEnabled(id, enabled, auditActor(me, "ui"));
    revalidatePath("/agents");
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: errMsg(e) };
  }
}

// Rename an agent / re-point a client-network agent at its client. Also the recovery path for an
// agent row recreated after data loss: the runner keeps polling with its baked-in id, so fixing
// the row here re-links it — no reinstall on the host.
export async function updateAgentIdentity(id: string, input: { name: string; clientSlug: string | null }) {
  try {
    const me = await requirePermission("agent.manage");
    const name = input.name.trim();
    if (!name) return { ok: false as const, error: "name is required" };
    const agent = await db.agent.findUnique({ where: { id }, select: { scope: true, name: true, clientId: true } });
    if (!agent) return { ok: false as const, error: "unknown agent" };
    let clientId: string | null = null;
    if (agent.scope === "client_network") {
      const slug = input.clientSlug?.trim() || null;
      if (!slug) return { ok: false as const, error: "pick a client for a client-network runner" };
      const client = await db.client.findUnique({ where: { slug }, select: { id: true } });
      if (!client) return { ok: false as const, error: "unknown client" };
      clientId = client.id;
    }
    await db.agent.update({ where: { id }, data: { name, clientId } });
    // Carries the PREVIOUS client too: a re-scope silently moves a runner (and its credentials) to
    // another client's work, which is the change you'd most want to trace back to a person.
    await recordAudit("agent.identity.set", {
      user: me, clientId,
      detail: { agentId: id, name, previousName: agent.name, fromClientId: agent.clientId, toClientId: clientId },
    });
    revalidatePath("/agents");
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: errMsg(e) };
  }
}

async function agentOp(fn: (actor: AuditActor) => Promise<unknown>) {
  try {
    const me = await requirePermission("agent.manage");
    await fn(auditActor(me, "ui"));
    revalidatePath("/agents");
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: errMsg(e) };
  }
}

export async function requestAgentUpdate(id: string) {
  try {
    const me = await requirePermission("agent.manage");
    await makeRunnerService(db).requestUpdate(id, auditActor(me, "ui"));
    revalidatePath("/agents");
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: errMsg(e) };
  }
}

// Operator action: arm a per-agent token refresh for one runner (joint->individual switch, or a
// rotate once it's already on its own token). Mirrors requestAgentUpdate's exact shape — the next
// heartbeat mints + delivers the token, then confirms once the runner authenticates with it.
export async function requestAgentTokenRefresh(id: string) {
  try {
    const me = await requirePermission("agent.manage");
    await makeRunnerService(db).requestTokenRefresh(id, auditActor(me, "ui"));
    revalidatePath("/agents");
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: errMsg(e) };
  }
}

// Fleet action: arm a token refresh for every enabled, non-deleted agent still on the shared
// token (tokenConfirmedAt null) — the one-click joint->individual migration. Per-agent failures
// don't stop the rest, mirroring updateAllOutdatedAgents.
export async function switchAllToPerAgentTokens() {
  let me;
  try { me = await requirePermission("agent.manage"); } catch (e) { return { ok: false as const, error: errMsg(e), queued: 0 }; }
  const ids = (
    await db.agent.findMany({ where: { enabled: true, deletedAt: null, tokenConfirmedAt: null }, select: { id: true } })
  ).map((a) => a.id);
  const svc = makeRunnerService(db);
  let queued = 0;
  for (const id of ids) {
    try { await svc.requestTokenRefresh(id, auditActor(me, "ui")); queued++; } catch { /* skip */ }
  }
  revalidatePath("/agents");
  return { ok: true as const, queued };
}

// Fleet action: rotate the per-agent token for EVERY enabled, non-deleted agent (already on
// individual tokens or not — a rotate arms the same refresh flag either way).
export async function rotateAllTokens() {
  let me;
  try { me = await requirePermission("agent.manage"); } catch (e) { return { ok: false as const, error: errMsg(e), queued: 0 }; }
  const ids = (
    await db.agent.findMany({ where: { enabled: true, deletedAt: null }, select: { id: true } })
  ).map((a) => a.id);
  const svc = makeRunnerService(db);
  let queued = 0;
  for (const id of ids) {
    try { await svc.requestTokenRefresh(id, auditActor(me, "ui")); queued++; } catch { /* skip */ }
  }
  revalidatePath("/agents");
  return { ok: true as const, queued };
}

// Failover priority (LOWER = higher precedence): a backup runner stands by while a higher-priority peer
// of the same scope is online. Clamped to 1..999.
export async function setAgentPriority(id: string, priority: number) {
  try {
    const me = await requirePermission("agent.manage");
    const p = Math.max(1, Math.min(999, Math.round(Number(priority) || 100)));
    const before = await db.agent.findUnique({ where: { id }, select: { priority: true } });
    await db.agent.update({ where: { id }, data: { priority: p } });
    await recordAudit("agent.priority.set", { user: me, detail: { agentId: id, from: before?.priority ?? null, to: p } });
    revalidatePath("/agents");
    return { ok: true as const, priority: p };
  } catch (e) {
    return { ok: false as const, error: errMsg(e) };
  }
}

// Ask the runner to restart (re-exec, no file pull) on its next heartbeat — for a wedged agent that
// heartbeats but stops claiming. Needs a supervised runner to relaunch.
export async function requestAgentRestart(id: string) {
  try {
    const me = await requirePermission("agent.manage");
    await makeRunnerService(db).requestRestart(id, auditActor(me, "ui"));
    revalidatePath("/agents");
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: errMsg(e) };
  }
}

// Ask the runner to install browser automation (portable Node if needed + Playwright + Chromium) on
// its next heartbeat — enables the 'browser' capability remotely, no shell on the host required.
export async function requestAgentBrowserInstall(id: string) {
  try {
    const me = await requirePermission("agent.manage");
    await makeRunnerService(db).requestBrowserInstall(id, auditActor(me, "ui"));
    revalidatePath("/agents");
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: errMsg(e) };
  }
}

// Ask this agent to move to the new app URL (the canary). Requires a global migration target set in
// Settings; the runner verifies the new URL, rewrites its own scheduled task, and switches.
export async function requestAgentMigrate(id: string) {
  try {
    const me = await requirePermission("agent.manage");
    await makeRunnerService(db).requestMigrate(id, auditActor(me, "ui"));
    revalidatePath("/agents");
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: errMsg(e) };
  }
}

// The Change-app-URL modal: save the global migration target and kick off the chosen scope in one
// action. "one" = the prove-it-first canary — the setting remembers WHICH agent is proving the move
// (proofAgentId) so any admin's Agents page can offer "move all the others" when it converges, and
// the migrate-failed writeback can clear the pending proof server-side. "fleet" = every agent
// migrates on its next heartbeat. Guarded like the settings API for the same setting.
export async function changeAppUrl(input: { targetUrl: string; scope: "one" | "fleet"; agentId?: string }) {
  try {
    const me = await requirePermission("settings.manage");
    const targetUrl = input.targetUrl.trim();
    let valid = false;
    try {
      const u = new URL(targetUrl);
      valid = u.protocol === "http:" || u.protocol === "https:";
    } catch { valid = false; }
    if (!valid) return { ok: false as const, error: "the new URL must be an absolute http(s) URL" };
    if (input.scope === "one" && !input.agentId) return { ok: false as const, error: "pick the agent to prove the move on" };

    const setting: AgentMigrationSetting =
      input.scope === "fleet"
        ? { enabled: true, targetUrl, proofAgentId: null }
        : { enabled: false, targetUrl, proofAgentId: input.agentId! };
    await setAppSetting(db, AGENT_MIGRATION_KEY, setting);
    await recordAudit("agent.migration.configure", { user: me, detail: { ...setting, via: "change-url-modal" } });
    if (input.scope === "one") await makeRunnerService(db).requestMigrate(input.agentId!, auditActor(me, "ui"));
    revalidatePath("/agents");
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: errMsg(e) };
  }
}

// "Move all the other agents now" on the proof-succeeded dialog: flip the already-proven target to
// fleet-wide and retire the proof pointer.
export async function confirmFleetAfterProof() {
  try {
    const me = await requirePermission("settings.manage");
    const s = await getAppSetting<AgentMigrationSetting>(db, AGENT_MIGRATION_KEY);
    if (!s?.targetUrl?.trim()) return { ok: false as const, error: "no migration target is set" };
    const next: AgentMigrationSetting = { enabled: true, targetUrl: s.targetUrl, proofAgentId: null };
    await setAppSetting(db, AGENT_MIGRATION_KEY, next);
    await recordAudit("agent.migration.configure", { user: me, detail: { ...next, via: "proof-confirm", provenBy: s.proofAgentId ?? null } });
    revalidatePath("/agents");
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: errMsg(e) };
  }
}

// "Not now" on the proof-succeeded dialog: keep the target, stop tracking the proof (the dialog
// stops appearing for every admin — the state is server-side, not per-browser).
export async function dismissProof() {
  try {
    const me = await requirePermission("settings.manage");
    const s = await getAppSetting<AgentMigrationSetting>(db, AGENT_MIGRATION_KEY);
    if (!s?.proofAgentId) return { ok: true as const };
    await setAppSetting(db, AGENT_MIGRATION_KEY, { ...s, proofAgentId: null });
    await recordAudit("agent.migration.proof_dismissed", { user: me, detail: { agentId: s.proofAgentId, targetUrl: s.targetUrl ?? null } });
    revalidatePath("/agents");
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: errMsg(e) };
  }
}

// Queue self-updates for several agents at once (Update selected / Update all). Per-agent failures
// don't stop the rest; the first error is surfaced alongside how many actually queued.
export async function requestAgentUpdates(ids: string[]) {
  let me;
  try { me = await requirePermission("agent.manage"); } catch (e) { return { ok: false as const, error: errMsg(e) }; }
  const svc = makeRunnerService(db);
  let queued = 0;
  let firstError: string | null = null;
  for (const id of ids) {
    try {
      await svc.requestUpdate(id, auditActor(me, "ui"));
      queued++;
    } catch (e) {
      firstError ??= errMsg(e);
    }
  }
  revalidatePath("/agents");
  return firstError ? { ok: false as const, error: `${firstError} (${queued}/${ids.length} queued)` } : { ok: true as const };
}
// Queue self-updates for EVERY outdated agent — backs the global "agents need updating" banner so an
// operator can update all from any page (no agent list in hand). Mirrors outdatedAgentCount's rule:
// enabled + checked-in + not on the served build. Per-agent failures don't stop the rest.
export async function updateAllOutdatedAgents() {
  let me;
  try { me = await requirePermission("agent.manage"); } catch (e) { return { ok: false as const, error: errMsg(e) }; }
  const build = runnerBuildId();
  const upToDate = (v: string | null) => !!v && /^[0-9a-f]{6,}$/.test(v) && v === build;
  const agents = await db.agent.findMany({
    where: { enabled: true, deletedAt: null, lastSeenAt: { not: null } },
    select: { id: true, version: true },
  });
  const ids = agents.filter((a) => !upToDate(a.version)).map((a) => a.id);
  const svc = makeRunnerService(db);
  let queued = 0;
  let firstError: string | null = null;
  for (const id of ids) {
    try { await svc.requestUpdate(id, auditActor(me, "ui")); queued++; } catch (e) { firstError ??= errMsg(e); }
  }
  revalidatePath("/agents");
  return firstError
    ? { ok: false as const, error: `${firstError} (${queued}/${ids.length} queued)` }
    : { ok: true as const, queued };
}

export const trashAgent = (id: string) => agentOp((who) => makeRunnerService(db).trashAgent(id, who));
export const restoreAgent = (id: string) => agentOp((who) => makeRunnerService(db).restoreAgent(id, who));
export const deleteAgentForever = (id: string) => agentOp((who) => makeRunnerService(db).deleteAgentForever(id, who));
