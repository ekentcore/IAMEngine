// Nightly database backup. Like every periodic task in this app it rides the runner-heartbeat
// sweep chain (no cron exists) with a durable AppSetting throttle, claimed race-safely via
// claimAppSetting (lib/settings.ts) so only one instance takes a given night's backup. Note the
// consequence of riding heartbeats: if no runner is heartbeating, the in-app backup has no clock —
// the standalone launchd layer (web/scripts/db-backup/) covers that gap.
//
// The dump itself is pg_dump -Fc (compressed custom format), verified readable with
// pg_restore --list before it replaces `latest.dump`, then dumps older than keepDays are pruned.
// Restore with web/scripts/db-backup/restore.sh (safe scratch-DB restore by default).
//
// Why in-app and not only launchd/cron: on macOS a NEW launchd agent is denied local-network
// access until someone clicks Allow in System Settings, but children of this (already granted)
// web app inherit its grant — so a pg_dump spawned here reaches the DB server on day one. The
// standalone launchd agent (web/scripts/db-backup/install-schedule.sh) is the app-independent
// second layer. Both write to the same directory; dumps are timestamped so they never collide.
//
// DEFAULT-ON: a missing/blank setting means enabled. Backups guard against the "someone reset
// the shared DB" incident — they must not depend on anyone remembering to flip a switch.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { claimAppSetting, getAppSetting, setAppSetting } from "../settings";
import { fireNotification } from "../notifications/sender";

const execFileP = promisify(execFile);

export const DB_BACKUP_KEY = "db_backup";

export type DbBackupResult = {
  ok: boolean;
  file?: string;
  sizeBytes?: number;
  dataTables?: number;
  error?: string;
  at: string; // ISO
};

export type DbBackupSetting = {
  enabled: boolean; // missing setting row => true (see normalize)
  hourLocal: number; // take the nightly backup at/after this local hour
  keepDays: number;
  backupDir: string;
  lastStartedAt?: string; // ISO — the durable throttle
  lastResult?: DbBackupResult;
};

export function defaultBackupDir(): string {
  return path.join(os.homedir(), "Backups", "iam-engine");
}

// The single place defaults are applied — everything downstream uses the filled fields as-is.
export function normalizeDbBackup(raw: unknown): DbBackupSetting {
  const r = (raw ?? {}) as Partial<DbBackupSetting>;
  return {
    enabled: r.enabled === undefined ? true : Boolean(r.enabled),
    hourLocal: typeof r.hourLocal === "number" && r.hourLocal >= 0 && r.hourLocal <= 23 ? Math.floor(r.hourLocal) : 2,
    keepDays: typeof r.keepDays === "number" && r.keepDays >= 1 ? Math.floor(r.keepDays) : 30,
    backupDir: typeof r.backupDir === "string" && r.backupDir.trim() ? r.backupDir : defaultBackupDir(),
    lastStartedAt: typeof r.lastStartedAt === "string" ? r.lastStartedAt : undefined,
    lastResult: r.lastResult,
  };
}

// The one projection of the setting shown to operators (settings loader + admin route both use it).
export type DbBackupStatus = {
  enabled: boolean;
  hourLocal: number;
  keepDays: number;
  backupDir: string;
  lastStartedAt: string | null;
  lastResult: DbBackupResult | null;
};

export function dbBackupStatus(raw: unknown): DbBackupStatus {
  const s = normalizeDbBackup(raw);
  return {
    enabled: s.enabled,
    hourLocal: s.hourLocal,
    keepDays: s.keepDays,
    backupDir: s.backupDir,
    lastStartedAt: s.lastStartedAt ?? null,
    lastResult: s.lastResult ?? null,
  };
}

// Due once per local day, at the first sweep tick at/after hourLocal. Comparing lastStartedAt to
// the most recent boundary (rather than "24h elapsed") keeps the backup anchored to the night
// instead of drifting later every day by the tick latency.
export function backupDue(s: DbBackupSetting, now: Date): boolean {
  if (!s.enabled) return false;
  const boundary = new Date(now);
  boundary.setHours(s.hourLocal, 0, 0, 0);
  if (boundary.getTime() > now.getTime()) boundary.setDate(boundary.getDate() - 1);
  if (!s.lastStartedAt) return true;
  // An unparseable stamp must read as "due", not as "never again" (NaN < x is always false).
  const last = Date.parse(s.lastStartedAt);
  return !Number.isFinite(last) || last < boundary.getTime();
}

// pg_dump/pg_restore live outside PATH under launchd; probe the usual Homebrew kegs.
// (backup.sh/restore.sh carry the same list for the standalone layer — keep them in step.)
function findPgBin(tool: string): string {
  const candidates = [
    process.env.PG_BIN_DIR,
    "/opt/homebrew/opt/libpq/bin",
    "/usr/local/opt/libpq/bin",
    "/opt/homebrew/opt/postgresql@17/bin",
    "/usr/local/opt/postgresql@17/bin",
  ];
  for (const dir of candidates) {
    if (dir && existsSync(path.join(dir, tool))) return path.join(dir, tool);
  }
  return tool; // hope it's on PATH; execFile will error clearly if not
}

// Node's execFile error message embeds the full command line — including the connection URL and
// its password. Anything stored, rendered, or notified must pass through here first.
function sanitizeError(msg: string): string {
  return msg.replace(/postgres(ql)?:\/\/[^@\s"']*@/gi, "postgresql://***@");
}

// Take one backup now. Exported separately from the sweep so the admin route can offer an
// explicit "Back up now" that bypasses the nightly schedule.
export async function runDbBackup(s: DbBackupSetting): Promise<DbBackupResult> {
  const at = new Date().toISOString();
  try {
    const rawUrl = process.env.DATABASE_URL ?? "";
    if (!rawUrl) throw new Error("DATABASE_URL is not set");
    // Drop ONLY Prisma's schema param — the pg tools reject it, but the rest of the query
    // string (sslmode, connect_timeout, …) is connection-relevant and must survive.
    const u = new URL(rawUrl);
    u.searchParams.delete("schema");
    const url = u.toString();
    const dbName = u.pathname.replace(/^\//, "") || "database";

    const dir = s.backupDir;
    await fs.mkdir(dir, { recursive: true });
    const stamp = at.replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const file = path.join(dir, `${dbName}-${stamp}.dump`);
    const tmp = `${file}.partial`;

    const pgDump = findPgBin("pg_dump");
    const pgRestore = findPgBin("pg_restore");
    try {
      await execFileP(pgDump, ["--format=custom", "--no-password", `--file=${tmp}`, url], {
        timeout: 10 * 60_000,
      });
      // verify the archive is readable before trusting it as a restore point
      const { stdout } = await execFileP(pgRestore, ["--list", tmp], { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
      const dataTables = (stdout.match(/TABLE DATA/g) ?? []).length;
      await fs.rename(tmp, file);
      const latest = path.join(dir, "latest.dump");
      try {
        await fs.rm(latest, { force: true });
        await fs.symlink(file, latest);
      } catch {
        // a broken symlink must not fail the backup
      }
      await pruneOldDumps(dir, dbName, s.keepDays);
      return { ok: true, file, sizeBytes: (await fs.stat(file)).size, dataTables, at };
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  } catch (err) {
    return { ok: false, error: sanitizeError(err instanceof Error ? err.message : String(err)), at };
  }
}

async function pruneOldDumps(dir: string, dbName: string, keepDays: number): Promise<void> {
  const cutoff = Date.now() - keepDays * 86_400_000;
  // Never prune the dump `latest.dump` points at — it is the advertised restore point even
  // when backups have been failing long enough for it to age past the window.
  const latestTarget = await fs.readlink(path.join(dir, "latest.dump")).catch(() => null);
  for (const name of await fs.readdir(dir)) {
    if (!name.startsWith(`${dbName}-`) || !name.endsWith(".dump")) continue;
    const p = path.join(dir, name);
    if (latestTarget && (p === latestTarget || name === path.basename(latestTarget))) continue;
    try {
      const st = await fs.lstat(p);
      if (st.isFile() && st.mtimeMs < cutoff) await fs.rm(p);
    } catch {
      // pruning is best-effort
    }
  }
}

// Persist a run's outcome without clobbering operator edits made while the dump ran: re-read the
// row and merge only the fields the run owns. (The claim already persisted lastStartedAt.)
export async function recordRunResult(db: PrismaClient, result: DbBackupResult): Promise<void> {
  const fresh = normalizeDbBackup(await getAppSetting(db, DB_BACKUP_KEY));
  await setAppSetting(db, DB_BACKUP_KEY, { ...fresh, lastResult: result });
}

// Heartbeats arrive every ~5s; throttle DB reads like the sibling sweeps do.
let lastTickAt = 0;
const TICK_EVERY_MS = 60_000;

// The heartbeat-driven entry point. Never throws (fire-and-forget off the heartbeat handler).
export async function sweepDbBackup(db: PrismaClient): Promise<void> {
  const tick = Date.now();
  if (tick - lastTickAt < TICK_EVERY_MS) return;
  lastTickAt = tick;

  const raw = await getAppSetting<unknown>(db, DB_BACKUP_KEY);
  const s = normalizeDbBackup(raw);
  if (!backupDue(s, new Date())) return;

  // Claim tonight's run; a racing instance's conditional write matches zero rows and loses.
  const claimed: DbBackupSetting = { ...s, lastStartedAt: new Date().toISOString() };
  if (!(await claimAppSetting(db, DB_BACKUP_KEY, raw, claimed))) return;

  const result = await runDbBackup(claimed);
  await recordRunResult(db, result);

  await db.auditLog
    .create({
      data: {
        actor: "system:db-backup",
        action: result.ok ? "db.backup.completed" : "db.backup.failed",
        detail: { ...result },
      },
    })
    .catch(() => {});

  if (!result.ok) {
    await fireNotification({
      event: "backupFailed",
      title: "Nightly database backup failed",
      detail: result.error ?? "unknown error",
      at: result.at,
    }).catch(() => {});
  }
}
