"use server";
// Operator-side agent management. Server actions call the service directly (server-side),
// so the UI doesn't hit — or need a token for — the runner-gated /api/agents endpoint.
import type { AgentScope } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { makeRunnerService } from "@/lib/jobs/runner-service";
import { HttpError } from "@/lib/jobs/types";

export async function enrollAgent(input: { name: string; scope: AgentScope; clientSlug?: string | null }) {
  try {
    const out = await makeRunnerService(db).enroll(input);
    revalidatePath("/agents");
    return { ok: true as const, ...out };
  } catch (e) {
    return { ok: false as const, error: e instanceof HttpError ? e.message : "internal error" };
  }
}

export async function setAgentEnabled(id: string, enabled: boolean) {
  try {
    await makeRunnerService(db).setEnabled(id, enabled);
    revalidatePath("/agents");
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: e instanceof HttpError ? e.message : "internal error" };
  }
}
