"use server";
// Operator-side agent management. Server actions call the service directly (server-side),
// so the UI doesn't hit — or need a token for — the runner-gated /api/agents endpoint.
import type { AgentScope } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { makeRunnerService } from "@/lib/jobs/runner-service";
import { HttpError } from "@/lib/jobs/types";
import { mintEnrollToken, enrollSecret } from "@/lib/runner/enroll-token";

// Mint a short-lived enroll token for the one-line installer (scope/client bound into the token).
export async function createEnrollToken(input: { scope: AgentScope; clientSlug: string | null }) {
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

const errMsg = (e: unknown) => (e instanceof HttpError ? e.message : "internal error");

export async function enrollAgent(input: { name: string; scope: AgentScope; clientSlug?: string | null }) {
  try {
    const out = await makeRunnerService(db).enroll(input);
    revalidatePath("/agents");
    return { ok: true as const, ...out };
  } catch (e) {
    return { ok: false as const, error: errMsg(e) };
  }
}

export async function setAgentEnabled(id: string, enabled: boolean) {
  try {
    await makeRunnerService(db).setEnabled(id, enabled);
    revalidatePath("/agents");
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: errMsg(e) };
  }
}

async function agentOp(fn: () => Promise<unknown>) {
  try {
    await fn();
    revalidatePath("/agents");
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: errMsg(e) };
  }
}

export const requestAgentUpdate = (id: string) => agentOp(() => makeRunnerService(db).requestUpdate(id));

// Queue self-updates for several agents at once (Update selected / Update all). Per-agent failures
// don't stop the rest; the first error is surfaced alongside how many actually queued.
export async function requestAgentUpdates(ids: string[]) {
  const svc = makeRunnerService(db);
  let queued = 0;
  let firstError: string | null = null;
  for (const id of ids) {
    try {
      await svc.requestUpdate(id);
      queued++;
    } catch (e) {
      firstError ??= errMsg(e);
    }
  }
  revalidatePath("/agents");
  return firstError ? { ok: false as const, error: `${firstError} (${queued}/${ids.length} queued)` } : { ok: true as const };
}
export const trashAgent = (id: string) => agentOp(() => makeRunnerService(db).trashAgent(id));
export const restoreAgent = (id: string) => agentOp(() => makeRunnerService(db).restoreAgent(id));
export const deleteAgentForever = (id: string) => agentOp(() => makeRunnerService(db).deleteAgentForever(id));
