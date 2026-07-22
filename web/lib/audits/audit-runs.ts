// Starting, tracking and reading a fleet sweep.
//
// A run takes minutes (a Delinea resolve plus several Graph reads per tenant, across ~200 clients), so
// it cannot happen inside a request: the route starts it, returns immediately, and /fleet-audit renders the
// last FINISHED run. The work runs in-process, detached from the request.
import type { PrismaClient } from "@prisma/client";
import { scanPermissions, scanLeakedSeats, scanEscalationHolders, auditTargets, type PermissionRow, type LeakRow, type EscalationHolderRow } from "./m365-audit";

export const AUDIT_KINDS = ["permissions", "leaked_seats", "escalation_holders"] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

export function isAuditKind(v: unknown): v is AuditKind {
  return typeof v === "string" && (AUDIT_KINDS as readonly string[]).includes(v);
}

// A run still marked "running" long after any real sweep could still be alive is not running: the
// process was restarted or redeployed mid-sweep, and nothing will ever finish it. Treat it as stale so
// one crashed run cannot block the button forever.
export const STALE_AFTER_MS = 30 * 60 * 1000;

export function isStale(startedAt: Date, now: Date): boolean {
  return now.getTime() - startedAt.getTime() > STALE_AFTER_MS;
}

export type AuditRun = {
  id: string;
  kind: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  startedBy: string | null;
  scanned: number;
  total: number;
  error: string | null;
  findings: unknown;
};

// The newest run of this kind, whatever its state — the page shows a finished one's findings and an
// in-flight one's progress.
export async function latestRun(db: PrismaClient, kind: AuditKind): Promise<AuditRun | null> {
  const r = await db.fleetAudit.findFirst({ where: { kind }, orderBy: { startedAt: "desc" } });
  return (r as AuditRun) ?? null;
}

export async function latestFinished(db: PrismaClient, kind: AuditKind): Promise<AuditRun | null> {
  const r = await db.fleetAudit.findFirst({ where: { kind, status: "done" }, orderBy: { startedAt: "desc" } });
  return (r as AuditRun) ?? null;
}

export type StartResult = { started: boolean; id?: string; reason?: string };

// Start a sweep unless a live one is already going. Deliberately NOT a lock: a duplicate sweep is
// read-only and harmless, it just wastes Graph quota — so a cheap check beats a coordination
// mechanism. The stale rule below is what stops a crashed run from wedging the button.
export async function startRun(
  db: PrismaClient,
  kind: AuditKind,
  startedBy: string | null,
  deps: { now?: () => Date; detach?: (fn: () => Promise<void>) => void } = {}
): Promise<StartResult> {
  const now = deps.now ?? (() => new Date());
  const detach = deps.detach ?? ((fn: () => Promise<void>) => { void fn(); });

  const live = await db.fleetAudit.findFirst({ where: { kind, status: "running" }, orderBy: { startedAt: "desc" } });
  if (live && !isStale(live.startedAt, now())) return { started: false, reason: "a scan is already running", id: live.id };
  // A stale run is finished off honestly rather than left hanging: it says what happened.
  if (live) {
    await db.fleetAudit.update({
      where: { id: live.id },
      data: { status: "failed", finishedAt: now(), error: "the app restarted while this scan was running" },
    });
  }

  const run = await db.fleetAudit.create({ data: { kind, status: "running", startedBy } });
  detach(async () => {
    try {
      // How many clients this run intends to visit, so the page shows "42 / 198" and not a spinner
      // with no end in sight. Counted here, not before the row exists, so the button returns at once.
      const total = (await auditTargets(db)).length;
      await db.fleetAudit.update({ where: { id: run.id }, data: { total } }).catch(() => {});
      const onProgress = async (done: number) => { await db.fleetAudit.update({ where: { id: run.id }, data: { scanned: done } }).catch(() => {}); };
      const findings: PermissionRow[] | LeakRow[] | EscalationHolderRow[] =
        kind === "permissions" ? await scanPermissions(db, { onProgress })
        : kind === "escalation_holders" ? await scanEscalationHolders(db, { onProgress })
        : await scanLeakedSeats(db, { onProgress });
      await db.fleetAudit.update({
        where: { id: run.id },
        data: { status: "done", finishedAt: new Date(), findings: findings as unknown as object, scanned: total },
      });
    } catch (e) {
      await db.fleetAudit
        .update({ where: { id: run.id }, data: { status: "failed", finishedAt: new Date(), error: (e as Error).message } })
        .catch(() => {});
    }
  });
  return { started: true, id: run.id };
}
