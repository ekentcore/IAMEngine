// Cancelling a detached auto-setup run (M365 / Google Workspace). Two halves:
//
//   • An in-process AbortController registry, keyed by run id. The run engine registers a controller
//     when it starts the detached work and releases it on ANY exit, so nothing about a finished or
//     cancelled run lingers in memory. The cancel path aborts the controller, which the setup cores
//     and their polling loops (device-code token poll, browser-job await) check between steps.
//   • stopAutoSetupJobs — stops the run's in-flight synthetic browser Jobs (the entra-devicecode /
//     google-oauth-signin / google-dwd-grant jobs minted on marker-flagged cases) via the runner
//     service's stopJob, so the runner abandons the browser work too.
//
// The DB run rows (status "cancelled", written by the cancel functions in {m365,google}-setup-run.ts)
// are the durable record; the registry is only the live-signal fast path. A cancel from a process that
// doesn't hold the controller (multi-instance deploy) still sticks: every terminal write in the run
// engines is guarded to never overwrite a cancelled row, and the fleet loop re-reads the run status
// between clients.
import type { PrismaClient } from "@prisma/client";
import type { ActorInput } from "@/lib/auth/actor";

export type SetupRunKind = "m365" | "google";

// globalThis-stashed so Next's dev hot-reload reuses one registry (same pattern as lib/db.ts).
const store = globalThis as unknown as { __setupRunControllers?: Map<string, AbortController> };
const controllers = (store.__setupRunControllers ??= new Map<string, AbortController>());

const key = (kind: SetupRunKind, runId: string) => `${kind}:${runId}`;

export function registerSetupRun(kind: SetupRunKind, runId: string): AbortSignal {
  const c = new AbortController();
  controllers.set(key(kind, runId), c);
  return c.signal;
}

export function releaseSetupRun(kind: SetupRunKind, runId: string): void {
  controllers.delete(key(kind, runId));
}

// Abort a registered run's signal. Returns whether a live controller was found (false = the run
// finished already, or it belongs to another process — the DB-status guards cover that case).
export function abortSetupRun(kind: SetupRunKind, runId: string): boolean {
  const c = controllers.get(key(kind, runId));
  if (!c) return false;
  c.abort();
  controllers.delete(key(kind, runId));
  return true;
}

// Test/diagnostic seam.
export function setupRunRegistered(kind: SetupRunKind, runId: string): boolean {
  return controllers.has(key(kind, runId));
}

// Structurally-typed subset of RunnerService (the ConnTestRunnerLike pattern) so this stays
// unit-testable with a fake, no real runner-service.ts wiring required.
export type StopJobServiceLike = {
  stopJob(jobId: string, actor: ActorInput): Promise<unknown>;
};

// Stop every in-flight browser Job the auto-setup flow dispatched: jobs of the flow's own systemKeys
// on marker-flagged synthetic cases (optionally one client's — the fleet cancel passes no clientId).
// Only ONE run per family can be live at a time (the start guards enforce it), so every in-flight
// marker job belongs to the run being cancelled. Best-effort per job: one already-terminal job (lost
// the race to the runner's result) must not stop the rest.
export async function stopAutoSetupJobs(
  db: PrismaClient,
  svc: StopJobServiceLike,
  input: { marker: string; systemKeys: string[]; clientId?: string; actor: ActorInput }
): Promise<number> {
  const jobs = await db.job.findMany({
    where: {
      status: { in: ["pending", "dispatched", "running"] },
      systemKey: { in: input.systemKeys },
      case: {
        payload: { path: [input.marker], equals: true },
        ...(input.clientId ? { clientId: input.clientId } : {}),
      },
    },
    select: { id: true },
  });
  let stopped = 0;
  for (const j of jobs) {
    try {
      await svc.stopJob(j.id, input.actor);
      stopped++;
    } catch {
      // already terminal / lost the race — ignore
    }
  }
  return stopped;
}
