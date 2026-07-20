// Starting, tracking and reading a detached M365 auto-setup run — the device-code+Graph-provision
// analog of audit-runs.ts. One client or the whole fleet, per-client progress in M365SetupRunClient,
// aggregate progress in M365SetupRun. The work runs in-process, detached from the request, because a
// device-code sign-in plus Graph provisioning per client can take minutes.
import type { PrismaClient } from "@prisma/client";
import type { SetupClientInput, SetupResult } from "./setup-m365-client";
import { recordAudit } from "@/lib/auth/audit";

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
export type RunSetupFn = (client: SetupClientInput, tenant: string, gaSecretRef?: string) => Promise<SetupResult>;

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

  detach(async () => {
    const deadline = now().getTime() + deadlineMs;
    let completed = 0, succeeded = 0, skipped = 0, failed = 0;
    try {
      for (const t of args.targets) {
        // A single client's row create / hasGlobalAdminSecret / status-update can throw transiently
        // (a dropped connection, etc.) — that must not abort the rest of the fleet sweep. Best-effort
        // mark this one client failed and move on.
        let row: { id: string } | undefined;
        try {
          row = await db.m365SetupRunClient.create({
            data: { runId: run.id, clientId: t.id, slug: t.slug, name: t.name, status: "pending" },
          });
          // Deadline: stop starting new clients (in-flight none, since sequential).
          if (now().getTime() > deadline) {
            await db.m365SetupRunClient.update({ where: { id: row.id }, data: { status: "skipped", skipReason: "run deadline reached before this client was reached" } });
            skipped++; completed++; continue;
          }
          // Dry-run: eligibility preview only — never device-code/provision.
          if (args.dryRun) {
            const eligible = await deps.hasGlobalAdminSecret(t.id);
            await db.m365SetupRunClient.update({ where: { id: row.id }, data: { status: "skipped", skipReason: eligible ? "dry run — would run (has GA secret)" : "dry run — would skip (no m365-global-admin secret)" } });
            skipped++; completed++; continue;
          }
          // Real: pre-skip when there's no GA login for the runner to sign in with — UNLESS a per-run
          // gaSecretRef was supplied (the override IS the eligibility; there may be no stored secret).
          if (!t.gaSecretRef && !(await deps.hasGlobalAdminSecret(t.id))) {
            await db.m365SetupRunClient.update({ where: { id: row.id }, data: { status: "skipped", skipReason: "no m365-global-admin secret" } });
            skipped++; completed++; continue;
          }
          await db.m365SetupRunClient.update({ where: { id: row.id }, data: { status: "running" } });
          let res: SetupResult;
          try {
            res = await deps.runSetup({ id: t.id, slug: t.slug, name: t.name, primaryDomain: t.primaryDomain, delineaFolderId: t.delineaFolderId }, tenantFor(t), t.gaSecretRef);
          } catch (e) {
            res = { ok: false, stage: "error", error: (e as Error).message, actions: [] };
          }
          // Surface the device user-code + warnings so the UI can show a manual fallback / MFA reason.
          // `log` carries the FULL step/error trail (SetupResult.actions — step names/ids/UPNs only,
          // never a secret value) so the UI's expandable run log can show exactly what happened, not
          // just the terminal stage/error.
          await db.m365SetupRunClient.update({
            where: { id: row.id },
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
          if (res.ok) succeeded++; else failed++;
          completed++;
          // Best-effort audit trail entry for this client's terminal outcome — fire-and-forget so a
          // slow/unreachable audit write can never delay (let alone derail) the sweep; recordAudit
          // itself never throws, but the extra .catch is defense-in-depth against a rejected promise.
          void recordAudit("m365.setup.client", {
            clientId: t.id,
            detail: { status: res.ok ? "done" : "failed", stage: res.stage, appId: res.appId, externalId: res.externalId, warnings: res.browserWarnings },
          }).catch(() => {});
        } catch (e) {
          if (row) {
            await db.m365SetupRunClient.update({ where: { id: row.id }, data: { status: "failed", error: (e as Error).message } }).catch(() => {});
          }
          failed++; completed++;
        }
        await db.m365SetupRun.update({ where: { id: run.id }, data: { completed, succeeded, skipped, failed } }).catch(() => {});
      }
      await db.m365SetupRun.update({ where: { id: run.id }, data: { status: "done", finishedAt: now(), completed, succeeded, skipped, failed } });
    } catch (e) {
      await db.m365SetupRun.update({ where: { id: run.id }, data: { status: "failed", finishedAt: now(), error: (e as Error).message, completed, succeeded, skipped, failed } }).catch(() => {});
    }
  });

  return { started: true, id: run.id };
}
