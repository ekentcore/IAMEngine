// Starting, tracking and reading a detached M365 auto-setup run — the device-code+Graph-provision
// analog of audit-runs.ts. One client or the whole fleet, per-client progress in M365SetupRunClient,
// aggregate progress in M365SetupRun. The work runs in-process, detached from the request, because a
// device-code sign-in plus Graph provisioning per client can take minutes.
import type { PrismaClient } from "@prisma/client";
import type { SetupClientInput, SetupResult } from "./setup-m365-client";
import { recordAudit } from "@/lib/auth/audit";
import { abortSetupRun, registerSetupRun, releaseSetupRun } from "./setup-cancel";

// Must exceed DEFAULT_RUN_DEADLINE_MS (2h) plus one in-flight client's ~15m device-code window, or a
// healthy long fleet sweep gets misjudged stale, force-failed, and duplicated (two concurrent MUTATING sweeps).
export const M365_SETUP_STALE_AFTER_MS = 3 * 60 * 60 * 1000; // 3h
// Default wall-clock ceiling for a fleet sweep: each client can burn ~15 min on device-code expiry, so
// an unbounded fleet run could take a whole day. Stop STARTING new clients past this; in-flight ones finish.
export const DEFAULT_RUN_DEADLINE_MS = 2 * 60 * 60 * 1000;

export function isSetupStale(startedAt: Date, now: Date): boolean {
  return now.getTime() - startedAt.getTime() > M365_SETUP_STALE_AFTER_MS;
}

export type SetupTarget = {
  id: string;
  slug: string;
  name: string;
  primaryDomain: string | null;
  delineaFolderId: string | null;
  // A per-run Global-Admin login reference (a Delinea externalId) from the modal — set on the single
  // per-client target only; the fleet path never sets this and keeps the persisted-secret path.
  gaSecretRef?: string;
};
// Live progress reporter: the run recorder passes one in so setupM365ForClient can report each step
// as it's entered (persisted onto the client row for the UI's step tracker). Best-effort.
export type StageReporter = (stage: string, meta?: { userCode?: string; verificationUri?: string }) => void | Promise<void>;
// `signal` is the run's cancel signal (see setup-cancel.ts) — the core checks it between steps so a
// cancelled run stops mutating (and its polling loops exit) instead of running to completion.
export type RunSetupFn = (client: SetupClientInput, tenant: string, gaSecretRef?: string, onStage?: StageReporter, signal?: AbortSignal) => Promise<SetupResult>;

export type StartArgs = { scope: string; targets: SetupTarget[]; dryRun?: boolean; startedBy: string | null };
export type RunDeps = {
  runSetup: RunSetupFn;
  hasGlobalAdminSecret: (clientId: string) => Promise<boolean>;
  now?: () => Date;
  detach?: (fn: () => Promise<void>) => void;
  deadlineMs?: number;
};
export type StartResult = { started: boolean; id?: string; reason?: string };

export async function latestM365SetupRun(db: PrismaClient, scope: string) {
  return db.m365SetupRun.findFirst({ where: { scope }, orderBy: { startedAt: "desc" }, include: { clients: true } });
}

// Tenant for the device-code flow: the client's primary domain is a valid tenant hint; fall back to
// "organizations" so the flow still initiates (the GA sign-in resolves the real tenant).
function tenantFor(t: SetupTarget): string {
  return t.primaryDomain && t.primaryDomain.includes(".") ? t.primaryDomain : "organizations";
}

export async function startM365SetupRun(db: PrismaClient, args: StartArgs, deps: RunDeps): Promise<StartResult> {
  const now = deps.now ?? (() => new Date());
  const detach = deps.detach ?? ((fn: () => Promise<void>) => { void fn(); });
  const deadlineMs = deps.deadlineMs ?? DEFAULT_RUN_DEADLINE_MS;

  // One live run per scope; a duplicate mutating sweep is NOT harmless, so this is a real guard (stale
  // runs are finished off so a crash can't wedge the button forever). The findFirst below is a
  // deterministic pre-check that handles the common already-running case cheaply; it is inherently
  // TOCTOU-racy against a concurrent caller, so the DB carries a partial unique index
  // ("M365SetupRun_one_running_per_scope") as the atomic backstop — see the create's catch below.
  const live = await db.m365SetupRun.findFirst({ where: { scope: args.scope, status: "running" }, orderBy: { startedAt: "desc" } });
  if (live && !isSetupStale(live.startedAt, now())) return { started: false, reason: "a setup run is already in progress", id: live.id };
  if (live) await db.m365SetupRun.update({ where: { id: live.id }, data: { status: "failed", finishedAt: now(), error: "the app restarted while this run was in progress" } });

  // Cross-family mutual exclusion: a per-client run and the fleet run must not run at once (the fleet
  // run may touch this very client). Same staleness treatment as the same-scope check above, but this
  // is advisory-only (no unique index spans scopes) — best-effort against the common case.
  const isClientScope = args.scope.startsWith("client:");
  const other = isClientScope
    ? await db.m365SetupRun.findFirst({ where: { scope: "fleet", status: "running" }, orderBy: { startedAt: "desc" } })
    : await db.m365SetupRun.findFirst({ where: { scope: { startsWith: "client:" }, status: "running" }, orderBy: { startedAt: "desc" } });
  if (other && !isSetupStale(other.startedAt, now())) return { started: false, reason: "another M365 setup run is in progress", id: other.id };

  let run;
  try {
    run = await db.m365SetupRun.create({ data: { scope: args.scope, status: "running", dryRun: Boolean(args.dryRun), startedBy: args.startedBy, total: args.targets.length } });
  } catch (e) {
    // Lost the create race against a concurrent caller for the same scope — the unique index rejected
    // us. Point at the winner instead of failing opaquely.
    const winner = await db.m365SetupRun.findFirst({ where: { scope: args.scope, status: "running" }, orderBy: { startedAt: "desc" } });
    if (winner) return { started: false, reason: "a setup run is already in progress", id: winner.id };
    throw e;
  }

  // The run's cancel signal: abortSetupRun (via cancelM365SetupRun) flips it, the loop below and the
  // setup core check it. Released on ANY exit so nothing about the run lingers in memory.
  const signal = registerSetupRun("m365", run.id);
  // Cross-process backstop: a cancel issued by an instance that doesn't hold this controller only
  // lands in the DB — re-read the run's status between clients so a fleet sweep still stops.
  const cancelledInDb = async () =>
    (await db.m365SetupRun.findUnique({ where: { id: run.id }, select: { status: true } }))?.status === "cancelled";

  detach(async () => {
    const deadline = now().getTime() + deadlineMs;
    let completed = 0, succeeded = 0, skipped = 0, failed = 0;
    try {
      for (const t of args.targets) {
        // Cancelled: stop before starting the next client. In-flight/pending rows were already
        // finalized by the cancel path itself; clients never reached simply aren't created.
        if (signal.aborted || (await cancelledInDb().catch(() => false))) break;
        // A single client's row create / hasGlobalAdminSecret / status-update can throw transiently
        // (a dropped connection, etc.) — that must not abort the rest of the fleet sweep. Best-effort
        // mark this one client failed and move on.
        let row: { id: string } | undefined;
        try {
          row = await db.m365SetupRunClient.create({
            data: { runId: run.id, clientId: t.id, slug: t.slug, name: t.name, status: "pending" },
          });
          // Skip writes share the cancel guard too (only a still-pending row skips), so a cancel that
          // lands right after the row create isn't overwritten and isn't counted.
          const skip = async (skipReason: string): Promise<boolean> => {
            const w = await db.m365SetupRunClient.updateMany({ where: { id: row!.id, status: "pending" }, data: { status: "skipped", skipReason } });
            if (w.count > 0) { skipped++; completed++; }
            return w.count > 0;
          };
          // Deadline: stop starting new clients (in-flight none, since sequential).
          if (now().getTime() > deadline) {
            await skip("run deadline reached before this client was reached");
            continue;
          }
          // Dry-run: eligibility preview only — never device-code/provision.
          if (args.dryRun) {
            const eligible = await deps.hasGlobalAdminSecret(t.id);
            await skip(eligible ? "dry run — would run (has GA secret)" : "dry run — would skip (no m365-global-admin secret)");
            continue;
          }
          // Real: pre-skip when there's no GA login for the runner to sign in with — UNLESS a per-run
          // gaSecretRef was supplied (the override IS the eligibility; there may be no stored secret).
          if (!t.gaSecretRef && !(await deps.hasGlobalAdminSecret(t.id))) {
            await skip("no m365-global-admin secret");
            continue;
          }
          await db.m365SetupRunClient.updateMany({ where: { id: row.id, status: "pending" }, data: { status: "running" } });
          // Live step tracker: persist the stage (and, at sign-in, the device user-code + URL) as the
          // run enters each step. Best-effort — swallow any write error so a progress blip can't derail
          // the run, and capture `row` in the closure so it targets THIS client's row.
          const stepRow = row;
          const onStage: StageReporter = async (stage, meta) => {
            await db.m365SetupRunClient.update({
              where: { id: stepRow.id },
              data: {
                stage,
                ...(meta?.userCode ? { userCode: meta.userCode } : {}),
                ...(meta?.verificationUri ? { verificationUri: meta.verificationUri } : {}),
              },
            }).catch(() => {});
          };
          let res: SetupResult;
          try {
            res = await deps.runSetup({ id: t.id, slug: t.slug, name: t.name, primaryDomain: t.primaryDomain, delineaFolderId: t.delineaFolderId }, tenantFor(t), t.gaSecretRef, onStage, signal);
          } catch (e) {
            res = { ok: false, stage: "error", error: (e as Error).message, actions: [] };
          }
          // Surface the device user-code + warnings so the UI can show a manual fallback / MFA reason.
          // `log` carries the FULL step/error trail (SetupResult.actions — step names/ids/UPNs only,
          // never a secret value) so the UI's expandable run log can show exactly what happened, not
          // just the terminal stage/error.
          // updateMany + a status filter, NOT update: the cancel path may have already flipped this
          // row to "cancelled", and a late terminal write from the still-unwinding closure must not
          // overwrite that (the cancel is what the operator saw happen).
          const wrote = await db.m365SetupRunClient.updateMany({
            where: { id: row.id, status: { in: ["pending", "running"] } },
            data: {
              status: res.ok ? "done" : "failed",
              stage: res.stage,
              appId: res.appId ?? null,
              wroteCreds: res.wroteCreds ?? null,
              verified: res.verified ?? null,
              error: res.ok ? null : (res.error ?? null),
              warnings: res.browserWarnings ?? [],
              userCode: res.userCode ?? null,
              verificationUri: res.verificationUri ?? null,
              log: res.actions ?? [],
            },
          });
          // Counters + audit only when the terminal write actually landed: a zero-count means the
          // cancel path owns this row, and counting/auditing it "done"/"failed" would misreport what
          // the operator saw happen (the cancel route writes its own audit entry).
          if (wrote.count > 0) {
            if (res.ok) succeeded++; else failed++;
            completed++;
            // Best-effort audit trail entry for this client's terminal outcome — fire-and-forget so a
            // slow/unreachable audit write can never delay (let alone derail) the sweep; recordAudit
            // itself never throws, but the extra .catch is defense-in-depth against a rejected promise.
            void recordAudit("m365.setup.client", {
              clientId: t.id,
              detail: { status: res.ok ? "done" : "failed", stage: res.stage, appId: res.appId, externalId: res.externalId, warnings: res.browserWarnings },
            }).catch(() => {});
          }
        } catch (e) {
          if (row) {
            const wrote = await db.m365SetupRunClient.updateMany({ where: { id: row.id, status: { in: ["pending", "running"] } }, data: { status: "failed", error: (e as Error).message } }).catch(() => null);
            if (!wrote || wrote.count > 0) { failed++; completed++; }
          } else {
            failed++; completed++;
          }
        }
        // Status-guarded so a cancelled run's counters aren't clobbered by the in-flight client's
        // stale local tallies after the cancel already froze them.
        await db.m365SetupRun.updateMany({ where: { id: run.id, status: "running" }, data: { completed, succeeded, skipped, failed } }).catch(() => {});
      }
      // Guarded like the per-client writes: a cancelled run stays cancelled — this only settles a run
      // that is still "running".
      await db.m365SetupRun.updateMany({ where: { id: run.id, status: "running" }, data: { status: "done", finishedAt: now(), completed, succeeded, skipped, failed } });
    } catch (e) {
      await db.m365SetupRun.updateMany({ where: { id: run.id, status: "running" }, data: { status: "failed", finishedAt: now(), error: (e as Error).message, completed, succeeded, skipped, failed } }).catch(() => {});
    } finally {
      releaseSetupRun("m365", run.id);
    }
  });

  return { started: true, id: run.id };
}

export type CancelSetupResult = { cancelled: boolean; id?: string; reason?: string };

// Operator "Cancel" on a live run: flip the run + its unsettled per-client rows to the terminal
// "cancelled" status (durable — every write in the detached closure is guarded to respect it), then
// abort the in-process signal so the closure's loops and the setup core stop as soon as they next
// check. Stopping the run's in-flight browser Job(s) is the ROUTE's job (stopAutoSetupJobs) — it
// needs the runner service, which this module deliberately doesn't depend on.
export async function cancelM365SetupRun(
  db: PrismaClient,
  scope: string,
  opts: { cancelledBy?: string | null; now?: () => Date } = {}
): Promise<CancelSetupResult> {
  const now = opts.now ?? (() => new Date());
  const live = await db.m365SetupRun.findFirst({ where: { scope, status: "running" }, orderBy: { startedAt: "desc" } });
  if (!live) return { cancelled: false, reason: "no setup run is in progress" };
  const note = `cancelled by ${opts.cancelledBy ?? "operator"}`;
  // Guarded flip: if the run settled between the findFirst and here, the cancel lost the race — report
  // that instead of stamping "cancelled" over a finished run.
  const flipped = await db.m365SetupRun.updateMany({ where: { id: live.id, status: "running" }, data: { status: "cancelled", finishedAt: now(), error: note } });
  if (flipped.count === 0) return { cancelled: false, reason: "the run just finished", id: live.id };
  await db.m365SetupRunClient.updateMany({ where: { runId: live.id, status: { in: ["pending", "running"] } }, data: { status: "cancelled", error: note } });
  abortSetupRun("m365", live.id);
  return { cancelled: true, id: live.id };
}
