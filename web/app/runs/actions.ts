"use server";
// Mark a run-log line "Fixed" (or reopen it). Resolving keys on the FINGERPRINT, so every occurrence
// of the same line for the same case — across re-runs — is marked at once and drops out of the log.
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requirePermission, AuthError } from "@/lib/auth/guard";
import { refreshCaseStatus } from "@/lib/jobs/runner-service";

type Result = { ok: true; count: number } | { ok: false; error: string };

// Accepting (or reopening) a FAILED line changes whether that step still fails its case. The cases
// list reads the stored CaseRequest.status, which is derived from Job.status and never sees the
// RunOutcome — so without this the case stays red on the list while every step on its page reads
// green (and nothing ever clears it, since accepting an outcome doesn't touch the job).
// Only TERMINAL cases are re-derived: a still-running case gets the right status from its next job
// result anyway (deriveCaseStatus now honors accepted failures), and re-deriving it here would flip a
// merely-queued case to "running".
async function refreshTerminalCases(fingerprints: string[]): Promise<void> {
  const fps = fingerprints.filter(Boolean);
  if (!fps.length) return;
  const affected = await db.runOutcome.findMany({
    where: { fingerprint: { in: fps }, status: "failed" },
    select: { caseRequestId: true },
  });
  const caseIds = [...new Set(affected.map((o) => o.caseRequestId).filter((id): id is string => Boolean(id)))];
  if (!caseIds.length) return;
  const terminal = await db.caseRequest.findMany({
    where: { id: { in: caseIds }, status: { in: ["completed", "failed"] } },
    select: { id: true },
  });
  for (const c of terminal) {
    await refreshCaseStatus(db, c.id);
    revalidatePath(`/cases/${c.id}`);
  }
  if (terminal.length) revalidatePath("/cases");
}

export async function resolveOutcomes(fingerprint: string): Promise<Result> {
  try {
    const me = await requirePermission("case.dispatch");
    if (!fingerprint) return { ok: false, error: "no fingerprint" };
    const r = await db.runOutcome.updateMany({
      where: { fingerprint, resolvedAt: null },
      data: { resolvedAt: new Date(), resolvedBy: me.email },
    });
    await refreshTerminalCases([fingerprint]);
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
    await refreshTerminalCases(fps);
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
    await refreshTerminalCases([fingerprint]); // un-accepting must put the failure back on the badge
    revalidatePath("/runs");
    return { ok: true, count: r.count };
  } catch (e) {
    return { ok: false, error: e instanceof AuthError ? e.message : "failed" };
  }
}
