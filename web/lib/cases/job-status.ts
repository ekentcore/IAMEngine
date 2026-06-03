import type { JobStatus } from "@prisma/client";

// A job in any of these has been claimed and/or executed — its case can no longer be re-planned.
// Everything EXCEPT the not-yet-started states (`pending`, `manual`). `skipped` belongs here: a
// no-executor job that already ran through dispatch is terminal, not re-plannable. Single source
// of truth so the UI guard (page.tsx) and the server guard (repository) can't drift.
export const STARTED_STATUSES: JobStatus[] = ["dispatched", "running", "succeeded", "failed", "skipped"];

export function hasStartedJobs(jobs: { status: string }[]): boolean {
  const started = STARTED_STATUSES as string[];
  return jobs.some((j) => started.includes(j.status));
}

// Thrown by the re-plan transaction when a job started executing between the pre-check and the
// job replacement (the TOCTOU window). Caught by replan-service and mapped to `already_started`.
export class CaseAlreadyStartedError extends Error {
  constructor() {
    super("case already started executing");
    this.name = "CaseAlreadyStartedError";
  }
}
