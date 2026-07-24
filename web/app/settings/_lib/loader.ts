// Shared server-side loader for the Settings pages (/settings and /settings/v2 — keep both thin).
import { db } from "@/lib/db";
import { getAppSetting } from "@/lib/settings";
import { DB_BACKUP_KEY, dbBackupStatus, type DbBackupStatus } from "@/lib/jobs/db-backup";
import { DRILL_KEY, restoreDrillStatus, type RestoreDrillStatus } from "@/lib/jobs/restore-drill";
import { backupFreshness, type BackupFreshness } from "@/lib/jobs/backup-freshness";
import { MAINTENANCE_KEY, normalizeMaintenance, type MaintenanceState } from "@/lib/jobs/maintenance";
import { buildInfo, type BuildInfo } from "@/lib/deploy/build-info";
import { latestFromGitHub, type GhCommit } from "@/lib/deploy/github-latest";
import { computeVerdict, type Verdict } from "@/lib/deploy/deployment-status";

// The backup card now shows the nightly dump status PLUS the restore-drill status and the derived
// freshness signal (feature #5). All three come from AppSettings — no new tables.
export type DbBackupCardLoad = {
  backup: DbBackupStatus;
  drill: RestoreDrillStatus;
  freshness: BackupFreshness;
};

export async function loadDbBackupStatus(): Promise<DbBackupCardLoad> {
  const [backupRaw, drillRaw, freshness] = await Promise.all([
    getAppSetting(db, DB_BACKUP_KEY),
    getAppSetting(db, DRILL_KEY),
    backupFreshness(db),
  ]);
  return { backup: dbBackupStatus(backupRaw), drill: restoreDrillStatus(drillRaw), freshness };
}

// Maintenance / drain card (feature #7): current state + the live in-flight count + the client list
// for the scoped-pause picker. The card then polls /api/admin/maintenance to keep the count fresh.
export type MaintenanceLoad = {
  state: MaintenanceState;
  inFlight: number;
  clients: { id: string; name: string }[];
};

export async function loadMaintenance(): Promise<MaintenanceLoad> {
  const [raw, inFlight, clients] = await Promise.all([
    getAppSetting<Partial<MaintenanceState>>(db, MAINTENANCE_KEY),
    db.job.count({ where: { status: { in: ["dispatched", "running"] } } }),
    db.client.findMany({ where: { archivedAt: null }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  return { state: normalizeMaintenance(raw), inFlight, clients };
}

// Deployment status (bottom-of-Settings note): what commit this server was built from vs the latest
// on GitHub main, so an operator can tell at a glance whether the site is running the newest push.
// Both reads are resilient — buildInfo() never throws, latestFromGitHub() returns an error result
// rather than throwing — so this can't break the Settings page even if GitHub is unreachable.
export type DeploymentStatusLoad = {
  running: BuildInfo;
  latest: GhCommit | null;
  behindBy: number | null;
  verdict: Verdict;
  repo: string;
  branch: string;
  checkedAt: string;
  error: string | null;
};

export async function loadDeploymentStatus(): Promise<DeploymentStatusLoad> {
  const running = buildInfo();
  const gh = await latestFromGitHub(running.sha);
  return {
    running,
    latest: gh.latest,
    behindBy: gh.behindBy,
    verdict: computeVerdict(running.sha, gh.latest?.sha ?? null, gh.behindBy),
    repo: gh.repo,
    branch: gh.branch,
    checkedAt: gh.fetchedAt,
    error: gh.error,
  };
}

// Every request, newest number first — hidden ones included. The caller splits them: `hidden` rows
// go to the collapsed Completed table, the rest stay on the board.
