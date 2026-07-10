// Planning half of "the ServiceNow ticket is resolved — mark the whole case completed": decide
// which steps still need flipping to succeeded, or refuse when a runner is mid-execution (same
// in-flight rule as trashCase — never yank state out from under a live job). Pure, so the route
// stays a thin transaction around this.
import type { Prisma } from "@prisma/client";

// One row of the scan result — shared by /api/cases/scan-servicenow and the toolbar dialog so the
// two sides can't silently drift.
export type ScanHit = { id: string; caseNumber: string; subject: string | null; clientName: string; status: string; snState: string };
export type ScanResult = { scanned: number; resolved: ScanHit[]; cancelled: ScanHit[]; errors: { caseNumber: string; error: string }[] };

// "A runner is mid-execution" — the rule trashCase and case completion share.
export function hasInFlightJob(jobs: { status: string }[]): boolean {
  return jobs.some((j) => j.status === "dispatched" || j.status === "running");
}

export type CompletionPlan<T> = { ok: false; reason: "in_flight" } | { ok: true; flip: T[] };

export function planCompletion<T extends { id: string; status: string }>(jobs: T[]): CompletionPlan<T> {
  if (hasInFlightJob(jobs)) return { ok: false, reason: "in_flight" };
  // succeeded/skipped are already terminal-done for deriveCaseStatus; everything else (pending,
  // manual, failed) gets marked succeeded via manualCompletionFlip so each step is individually
  // undoable — back to its true prior state — via the existing per-step mark-complete toggle.
  return { ok: true, flip: jobs.filter((j) => j.status !== "succeeded" && j.status !== "skipped") };
}

// The Job update that records "an operator marked this step complete by hand": succeeded, flagged
// manualCompletion, and carrying priorStatus/priorError so unmarking restores the step exactly
// (a failed step's error text must survive a force-complete). Used by the per-step toggle and the
// whole-case completion; keep the write shape in one place.
export function manualCompletionFlip(
  job: { status: string; result: unknown; error?: string | null },
  now: Date
): { status: "succeeded"; result: Prisma.InputJsonValue; error: null; finishedAt: Date } {
  const result = (job.result ?? {}) as Record<string, unknown>;
  return {
    status: "succeeded",
    result: { ...result, manualCompletion: true, priorStatus: job.status, ...(job.error ? { priorError: job.error } : {}) } as Prisma.InputJsonValue,
    error: null,
    finishedAt: now,
  };
}
