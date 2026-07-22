// Generalized, vendor-agnostic setup-run orchestrator — the successor to the bespoke m365-setup-run.ts /
// google-setup-run.ts pairs. Keyed by `moduleKey`, it starts a detached run, tracks per-client progress in
// ModuleSetupRunClient (vendor-specific fields in the `detail` JSON), and rolls the aggregate up on
// ModuleSetupRun. The per-vendor BROWSER auto-provisioning flows (Spanning, Adobe, Zoom, … built in later
// PRs) plug their provisioning logic in via `deps.runSetup` and reuse THIS one run/row/sweep instead of a
// new table pair each. Provided ready-to-use; the guided (paste/vault) P0a flow doesn't need it, so nothing
// calls it yet.
import type { PrismaClient } from "@prisma/client";
import { recordAudit } from "@/lib/auth/audit";
import { registerSetupRun, releaseSetupRun } from "./setup-cancel";
import { isSetupStale } from "./m365-setup-run";

// The result a vendor's provisioning step reports back — mirrors the m365/google SetupResult shape but
// vendor-agnostic. `detail` carries non-secret vendor specifics (e.g. { appId } / { tokenId }); `externalId`
// is the Delinea id the credential was vaulted as, when the flow vaulted one.
export type ModuleSetupResult = {
  ok: boolean;
  stage: string;
  error?: string;
  warnings?: string[];
  actions?: string[];
  detail?: Record<string, unknown>;
  externalId?: string;
  // A manual-action card (e.g. an MFA the browser can't complete) — when present, terminal = needs_action.
  userAction?: Record<string, unknown>;
};

export type ModuleStageReporter = (stage: string, extra?: Partial<ModuleSetupResult>) => Promise<void>;

export type ModuleSetupTarget = { id: string; slug: string; name: string };

export type StartModuleArgs = {
  moduleKey: string;
  scope: string; // "client:<clientId>" | "fleet"
  targets: ModuleSetupTarget[];
  startedBy: string | null;
  startedById?: string | null;
};

export type ModuleRunDeps = {
  // Provision + vault for ONE client. `onStage` persists live progress; `signal` is the cancel signal.
  runSetup: (client: ModuleSetupTarget, onStage: ModuleStageReporter, signal?: AbortSignal) => Promise<ModuleSetupResult>;
  now?: () => Date;
  detach?: (fn: () => Promise<void>) => void;
};

export type StartModuleResult = { started: true; id: string } | { started: false; reason: string; id?: string };

export function moduleSetupScope(clientId: string): string {
  return `client:${clientId}`;
}

export async function latestModuleSetupRun(db: PrismaClient, moduleKey: string, scope: string) {
  return db.moduleSetupRun.findFirst({ where: { moduleKey, scope }, orderBy: { startedAt: "desc" }, include: { clients: true } });
}

// Start a detached run for `moduleKey` + `scope`. One live run per (moduleKey, scope); a stale run (the
// app restarted mid-flight) is finished off so a crash can't wedge the affordance forever.
export async function startModuleSetupRun(db: PrismaClient, args: StartModuleArgs, deps: ModuleRunDeps): Promise<StartModuleResult> {
  const now = deps.now ?? (() => new Date());
  const detach = deps.detach ?? ((fn: () => Promise<void>) => { void fn(); });

  const live = await db.moduleSetupRun.findFirst({ where: { moduleKey: args.moduleKey, scope: args.scope, status: "running" }, orderBy: { startedAt: "desc" } });
  if (live && !isSetupStale(live.startedAt, now())) return { started: false, reason: "a setup run is already in progress", id: live.id };
  if (live) await db.moduleSetupRun.update({ where: { id: live.id }, data: { status: "failed", finishedAt: now(), error: "the app restarted while this run was in progress" } });

  const run = await db.moduleSetupRun.create({
    data: { moduleKey: args.moduleKey, scope: args.scope, status: "running", startedBy: args.startedBy, startedById: args.startedById ?? null, total: args.targets.length },
  });

  const signal = registerSetupRun("module", run.id);
  const cancelledInDb = async () =>
    (await db.moduleSetupRun.findUnique({ where: { id: run.id }, select: { status: true } }))?.status === "cancelled";

  detach(async () => {
    let completed = 0, succeeded = 0, failed = 0;
    try {
      for (const t of args.targets) {
        if (signal.aborted || (await cancelledInDb().catch(() => false))) break;
        let row: { id: string } | undefined;
        try {
          row = await db.moduleSetupRunClient.create({ data: { runId: run.id, clientId: t.id, slug: t.slug, name: t.name, status: "running" } });
          const stepRow = row;
          const onStage: ModuleStageReporter = async (stage, extra) => {
            await db.moduleSetupRunClient.update({
              where: { id: stepRow.id },
              data: { stage, ...(extra?.detail ? { detail: extra.detail as object } : {}) },
            }).catch(() => {});
          };

          let res: ModuleSetupResult;
          try {
            res = await deps.runSetup(t, onStage, signal);
          } catch (e) {
            res = { ok: false, stage: "error", error: (e as Error).message, warnings: [], actions: [] };
          }
          const status = res.ok && !res.userAction ? "done" : res.ok && res.userAction ? "needs_action" : "failed";

          // Guarded update: a cancel may have already finalized this row.
          await db.moduleSetupRunClient.updateMany({
            where: { id: row.id, status: { in: ["pending", "running"] } },
            data: {
              status,
              stage: res.stage,
              error: res.ok ? null : (res.error ?? null),
              warnings: res.warnings ?? [],
              detail: (res.detail ?? undefined) as object | undefined,
              log: res.actions ?? [],
            },
          });
          completed++;
          if (res.ok) succeeded++; else failed++;

          // Automation on behalf of whoever started the run. The initiating user id is persisted on the
          // run row (startedById); once recordAudit carries a userId with a non-user actor label, upgrade
          // this to attribute the row to that user (rendered "Name (Automation)").
          void recordAudit(`${args.moduleKey}.setup.client`, {
            actor: `system:${args.moduleKey}-setup`,
            clientId: t.id,
            detail: { status, stage: res.stage, externalId: res.externalId, warnings: res.warnings },
          }).catch(() => {});
        } catch (e) {
          if (row) await db.moduleSetupRunClient.updateMany({ where: { id: row.id, status: { in: ["pending", "running"] } }, data: { status: "failed", error: (e as Error).message } }).catch(() => {});
          completed++; failed++;
        }
      }
      const terminal = failed === 0 ? "done" : (succeeded > 0 ? "done" : "failed");
      await db.moduleSetupRun.updateMany({
        where: { id: run.id, status: "running" },
        data: { status: terminal, finishedAt: now(), completed, succeeded, failed },
      }).catch(() => {});
    } finally {
      releaseSetupRun("module", run.id);
    }
  });

  return { started: true, id: run.id };
}
