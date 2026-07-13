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
import { runnerBuildId } from "@/lib/runner/bundle";

// Mint a short-lived enroll token for the one-line installer (scope/client bound into the token).
export async function createEnrollToken(input: { scope: AgentScope; clientSlug: string | null }) {
  try { await requirePermission("agent.manage"); } catch (e) { return { ok: false as const, error: errMsg(e) }; }
  const slug = input.clientSlug?.trim() || null; // trim — a stray space breaks the client lookup
  if (input.scope === "client_network" && !slug) {
    return { ok: false as const, error: "pick a client for a client-network runner" };
  }
  const token = mintEnrollToken(
    { scope: input.scope, client: input.scope === "client_network" ? slug : null },
    enrollSecret(),
    Date.now()
  );
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
    await requirePermission("agent.manage");
    await makeRunnerService(db).setEnabled(id, enabled);
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
    await requirePermission("agent.manage");
    const name = input.name.trim();
    if (!name) return { ok: false as const, error: "name is required" };
    const agent = await db.agent.findUnique({ where: { id }, select: { scope: true } });
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
    revalidatePath("/agents");
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: errMsg(e) };
  }
}

async function agentOp(fn: () => Promise<unknown>) {
  try {
    await requirePermission("agent.manage");
    await fn();
    revalidatePath("/agents");
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: errMsg(e) };
  }
}

export async function requestAgentUpdate(id: string) {
  try {
    const me = await requirePermission("agent.manage");
    await makeRunnerService(db).requestUpdate(id, me.email);
    revalidatePath("/agents");
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: errMsg(e) };
  }
}

// Failover priority (LOWER = higher precedence): a backup runner stands by while a higher-priority peer
// of the same scope is online. Clamped to 1..999.
export async function setAgentPriority(id: string, priority: number) {
  try {
    await requirePermission("agent.manage");
    const p = Math.max(1, Math.min(999, Math.round(Number(priority) || 100)));
    await db.agent.update({ where: { id }, data: { priority: p } });
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
    await makeRunnerService(db).requestRestart(id, me.email);
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
      await svc.requestUpdate(id, me.email);
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
    try { await svc.requestUpdate(id, me.email); queued++; } catch (e) { firstError ??= errMsg(e); }
  }
  revalidatePath("/agents");
  return firstError
    ? { ok: false as const, error: `${firstError} (${queued}/${ids.length} queued)` }
    : { ok: true as const, queued };
}

export const trashAgent = (id: string) => agentOp(() => makeRunnerService(db).trashAgent(id));
export const restoreAgent = (id: string) => agentOp(() => makeRunnerService(db).restoreAgent(id));
export const deleteAgentForever = (id: string) => agentOp(() => makeRunnerService(db).deleteAgentForever(id));
