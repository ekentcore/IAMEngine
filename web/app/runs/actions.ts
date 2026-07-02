"use server";
// Mark a run-log line "Fixed" (or reopen it). Resolving keys on the FINGERPRINT, so every occurrence
// of the same line for the same case — across re-runs — is marked at once and drops out of the log.
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requirePermission, AuthError } from "@/lib/auth/guard";

type Result = { ok: true; count: number } | { ok: false; error: string };

export async function resolveOutcomes(fingerprint: string): Promise<Result> {
  try {
    const me = await requirePermission("case.dispatch");
    if (!fingerprint) return { ok: false, error: "no fingerprint" };
    const r = await db.runOutcome.updateMany({
      where: { fingerprint, resolvedAt: null },
      data: { resolvedAt: new Date(), resolvedBy: me.email },
    });
    revalidatePath("/runs");
    return { ok: true, count: r.count };
  } catch (e) {
    return { ok: false, error: e instanceof AuthError ? e.message : "failed" };
  }
}

// Bulk "Fixed": resolve every occurrence of each selected line (by fingerprint) in one call.
export async function resolveManyOutcomes(fingerprints: string[]): Promise<Result> {
  try {
    const me = await requirePermission("case.dispatch");
    const fps = [...new Set((fingerprints ?? []).filter((f): f is string => typeof f === "string" && f !== ""))];
    if (!fps.length) return { ok: false, error: "nothing selected" };
    const r = await db.runOutcome.updateMany({
      where: { fingerprint: { in: fps }, resolvedAt: null },
      data: { resolvedAt: new Date(), resolvedBy: me.email },
    });
    revalidatePath("/runs");
    return { ok: true, count: r.count };
  } catch (e) {
    return { ok: false, error: e instanceof AuthError ? e.message : "failed" };
  }
}

export async function reopenOutcomes(fingerprint: string): Promise<Result> {
  try {
    await requirePermission("case.dispatch");
    if (!fingerprint) return { ok: false, error: "no fingerprint" };
    const r = await db.runOutcome.updateMany({
      where: { fingerprint, resolvedAt: { not: null } },
      data: { resolvedAt: null, resolvedBy: null },
    });
    revalidatePath("/runs");
    return { ok: true, count: r.count };
  } catch (e) {
    return { ok: false, error: e instanceof AuthError ? e.message : "failed" };
  }
}
