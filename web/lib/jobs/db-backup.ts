// Nightly database backup. Like every periodic task in this app it rides the runner-heartbeat
// sweep chain (no cron exists) with a DURABLE AppSetting throttle, and follows conn-sweep's
// claim-by-conditional-update so only one instance takes a given night's backup.
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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { getAppSetting, setAppSetting } from "../settings";
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
  hourLocal?: number; // take the nightly backup at/after this local hour; default 2 (02:00)
  keepDays?: number; // default 30
  backupDir?: string; // default ~/Backups/iam-engine
  lastStartedAt?: string; // ISO — the durable throttle
  lastResult?: DbBackupResult;
};

export function normalizeDbBackup(raw: unknown): DbBackupSetting {
  const r = (raw ?? {}) as Partial<DbBackupSetting>;
  return {
    enabled: r.enabled === undefined ? true : Boolean(r.enabled),
    hourLocal: typeof r.hourLocal === "number" && r.hourLocal >= 0 && r.hourLocal <= 23 ? Math.floor(r.hourLocal) : 2,
    keepDays: typeof r.keepDays === "number" && r.keepDays >= 1 ? Math.floor(r.keepDays) : 30,
    backupDir: typeof r.backupDir === "string" && r.backupDir.trim() ? r.backupDir : undefined,
    lastStartedAt: typeof r.lastStartedAt === "string" ? r.lastStartedAt : undefined,
    lastResult: r.lastResult,
  };
}

// Due once per local day, at the first sweep tick at/after hourLocal. Comparing lastStartedAt to
// the most recent boundary (rather than "24h elapsed") keeps the backup anchored to the night
// instead of drifting later every day by the tick latency.
export function backupDue(s: DbBackupSetting, now: Date): boolean {
  if (!s.enabled) return false;
  const boundary = new Date(now);
  boundary.setHours(s.hourLocal ?? 2, 0, 0, 0);
  if (boundary.getTime() > now.getTime()) boundary.setDate(boundary.getDate() - 1);
  if (!s.lastStartedAt) return true;
  return Date.parse(s.lastStartedAt) < boundary.getTime();
}

export function defaultBackupDir(): string {
  return path.join(os.homedir(), "Backups", "iam-engine");
}

// pg_dump/pg_restore live outside PATH under launchd; probe the usual Homebrew kegs.
function findPgBin(tool: string): string {
  const candidates = [
    process.env.PG_BIN_DIR,
    "/opt/homebrew/opt/libpq/bin",
    "/usr/local/opt/libpq/bin",
    "/opt/homebrew/opt/postgresql@17/bin",
    "/usr/local/opt/postgresql@17/bin",
  ];
  for (const dir of candidates) {
    if (dir && fs.existsSync(path.join(dir, tool))) return path.join(dir, tool);
  }
  return tool; // hope it's on PATH; execFile will error clearly if not
}

// Take one backup now. Exported separately from the sweep so the admin route can offer
// an explicit "Back up now" that bypasses the schedule (but not the claim).
export async function runDbBackup(s: DbBackupSetting): Promise<DbBackupResult> {
  const at = new Date().toISOString();
  try {
    const rawUrl = process.env.DATABASE_URL ?? "";
    if (!rawUrl) throw new Error("DATABASE_URL is not set");
    const url = rawUrl.split("?")[0]; // pg tools reject Prisma's ?schema= param
    const dbName = url.slice(url.lastIndexOf("/") + 1) || "database";

    const dir = s.backupDir ?? defaultBackupDir();
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const file = path.join(dir, `${dbName}-${stamp}.dump`);
    const tmp = `${file}.partial`;

    const pgDump = findPgBin("pg_dump");
    const pgRestore = findPgBin("pg_restore");
    try {
      await execFileP(pgDump, ["--format=custom", "--compress=9", "--no-password", `--file=${tmp}`, url], {
        timeout: 10 * 60_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      // verify the archive is readable before trusting it as a restore point
      const { stdout } = await execFileP(pgRestore, ["--list", tmp], { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
      const dataTables = (stdout.match(/TABLE DATA/g) ?? []).length;
      fs.renameSync(tmp, file);
      const latest = path.join(dir, "latest.dump");
      try {
        fs.rmSync(latest, { force: true });
        fs.symlinkSync(file, latest);
      } catch {
        // a broken symlink must not fail the backup
      }
      pruneOldDumps(dir, dbName, s.keepDays ?? 30);
      return { ok: true, file, sizeBytes: fs.statSync(file).size, dataTables, at };
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), at };
  }
}

function pruneOldDumps(dir: string, dbName: string, keepDays: number): void {
  const cutoff = Date.now() - keepDays * 86_400_000;
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(`${dbName}-`) || !name.endsWith(".dump")) continue;
    const p = path.join(dir, name);
    try {
      const st = fs.lstatSync(p);
      if (st.isFile() && st.mtimeMs < cutoff) fs.rmSync(p);
    } catch {
      // pruning is best-effort
    }
  }
}

// Heartbeats arrive every ~5s; throttle DB reads like the sibling sweeps do.
let lastTickAt = 0;
const TICK_EVERY_MS = 60_000;

// The heartbeat-driven entry point. Never throws (fire-and-forget off the heartbeat handler).
export async function sweepDbBackup(db: PrismaClient, deps?: { now?: () => Date }): Promise<void> {
  const now = deps?.now ?? (() => new Date());
  const tick = now().getTime();
  if (tick - lastTickAt < TICK_EVERY_MS) return;
  lastTickAt = tick;

  const raw = await getAppSetting<unknown>(db, DB_BACKUP_KEY);
  const s = normalizeDbBackup(raw);
  if (!backupDue(s, now())) return;

  // Claim tonight's run with a conditional update; a racing instance's claim matches zero rows.
  const claimed: DbBackupSetting = { ...s, lastStartedAt: now().toISOString() };
  if (!(await claimSetting(db, raw, claimed))) return;

  const result = await runDbBackup(claimed);
  await setAppSetting(db, DB_BACKUP_KEY, { ...claimed, lastResult: result });

  await db.auditLog
    .create({
      data: {
        actor: "system:db-backup",
        action: result.ok ? "db.backup.completed" : "db.backup.failed",
        detail: { ...result, sizeBytes: result.sizeBytes ?? null, file: result.file ?? null, error: result.error ?? null },
      },
    })
    .catch(() => {});

  if (!result.ok) {
    await fireNotification({
      event: "backupFailed",
      title: "Nightly database backup FAILED",
      detail: result.error ?? "unknown error",
      at: result.at,
    }).catch(() => {});
  }
}

// Conditional claim, copied from conn-sweep: update only if the row still holds what we read.
async function claimSetting(db: PrismaClient, expected: unknown, next: DbBackupSetting): Promise<boolean> {
  try {
    return await db.$transaction(async (tx) => {
      const row = await tx.appSetting.findUnique({ where: { key: DB_BACKUP_KEY }, select: { value: true } });
      let current: unknown = null;
      if (row) {
        try {
          current = JSON.parse(row.value);
        } catch {
          current = null;
        }
      }
      if (JSON.stringify(current) !== JSON.stringify(expected ?? null)) return false;
      // AppSetting.value is a String column — store the JSON text (an object would make
      // Prisma throw, the catch would swallow it, and the claim would silently never win).
      const v = JSON.stringify(next);
      await tx.appSetting.upsert({
        where: { key: DB_BACKUP_KEY },
        update: { value: v },
        create: { key: DB_BACKUP_KEY, value: v },
      });
      return true;
    });
  } catch {
    return false;
  }
}
