// Feature #5, Phase 1 (LIVE, local-testable) — the scheduled restore drill.
//
// "Backups you've never restored aren't backups." This job proves the restore path continuously: it
// takes the latest dump, restores it into a THROWAWAY scratch DB on the same server, runs integrity
// assertions (schema-vs-live, key-table row counts, a canary join, an orphan-FK check), then drops the
// scratch DB in a `finally` — and alerts loudly (via the existing `backupFailed` notification) if any
// step fails. A bad/corrupt/empty dump MUST fail the drill: a drill that can't fail is theatre.
//
// It rides the runner-heartbeat sweep chain exactly like sweepDbBackup — self-throttle → check due →
// claimAppSetting the run → execute → record → audit → alert — on a WEEKLY boundary (a full restore is
// heavier than a dump). Default-ON: a drill you must remember to enable won't run.
//
// The mechanic reuses restore.sh's scratch-DB semantics (create → pg_restore --exit-on-error → assert →
// DROP). The live DB is UNTOUCHABLE: an explicit scratch target is always used and asserted ≠ live.
//
// Pure logic (drillDue, evaluateIntegrity, computeStalenessAlert) is unit-testable with no DB/az. The
// orchestration (runRestoreDrill) takes an injectable DrillDeps so the whole flow — including the
// negative "corrupt dump fails" path and the finally-drop — is testable without a real Postgres.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import type { PrismaClient } from "@prisma/client";
import { claimAppSetting, getAppSetting, setAppSetting } from "../settings";
import { fireNotification } from "../notifications/sender";
import { findPgBin, sanitizeError, DB_BACKUP_KEY, normalizeDbBackup, type DbBackupSetting } from "./db-backup";
import {
  loadAzureBackup, azureConfigured, downloadLatestBlob, sha256File, type AzureBackupConfig,
} from "./backup-blob";
import { backupFreshness } from "./backup-freshness";

const execFileP = promisify(execFile);

// S3: separate key from `backup.azure` so this sweep claims its own row race-safely.
export const DRILL_KEY = "backup.azure.drill";

// The key tables a real restore of this app must repopulate. NB: the cases table is `CaseRequest`
// (there is no `Case` model), and per-client rows hang off it — see the seams doc.
export const KEY_TABLES = ["Client", "ClientSystem", "CaseRequest", "Job", "AuditLog", "Secret", "User", "AppSetting"] as const;

export type RestoreDrillResult = {
  ok: boolean;
  dumpUnderTest?: string;
  source?: "local" | "blob";
  checksumOk?: boolean;
  tables?: number;
  rowCounts?: Record<string, number>;
  canaryOk?: boolean;
  orphanCount?: number;
  failures?: string[]; // the specific assertion(s) that failed (empty on success)
  durationMs?: number;
  scratchDb?: string;
  error?: string;
  at: string; // ISO
};

export type RestoreDrillSetting = {
  enabled: boolean;   // missing => true (a drill you must remember to enable won't run)
  dayOfWeek: number;  // 0=Sun..6=Sat — weekly boundary
  hourLocal: number;  // run at/after this local hour on dayOfWeek
  lastStartedAt?: string;      // durable weekly throttle
  lastResult?: RestoreDrillResult;
  lastStaleAlertAt?: string;   // throttle for the ">26h no backup" staleness alert (§3.7)
};

export function normalizeDrill(raw: unknown): RestoreDrillSetting {
  const r = (raw ?? {}) as Partial<RestoreDrillSetting>;
  return {
    enabled: r.enabled === undefined ? true : Boolean(r.enabled),
    dayOfWeek: typeof r.dayOfWeek === "number" && r.dayOfWeek >= 0 && r.dayOfWeek <= 6 ? Math.floor(r.dayOfWeek) : 0,
    hourLocal: typeof r.hourLocal === "number" && r.hourLocal >= 0 && r.hourLocal <= 23 ? Math.floor(r.hourLocal) : 3,
    lastStartedAt: typeof r.lastStartedAt === "string" ? r.lastStartedAt : undefined,
    lastResult: r.lastResult,
    lastStaleAlertAt: typeof r.lastStaleAlertAt === "string" ? r.lastStaleAlertAt : undefined,
  };
}

// The most recent weekly boundary at/before `now` for (dayOfWeek, hourLocal), in LOCAL time (mirrors
// backupDue's local anchoring). Step back a day at a time until the weekday matches and it's not in the
// future.
function mostRecentWeeklyBoundary(now: Date, dayOfWeek: number, hourLocal: number): Date {
  const b = new Date(now);
  b.setHours(hourLocal, 0, 0, 0);
  for (let i = 0; i < 8; i++) {
    if (b.getDay() === dayOfWeek && b.getTime() <= now.getTime()) return b;
    b.setDate(b.getDate() - 1);
    b.setHours(hourLocal, 0, 0, 0);
  }
  return b;
}

// Due once per weekly boundary — same reasoning as backupDue but on a weekly anchor. Disabled ⇒ never;
// never-run ⇒ due; an unparseable stamp ⇒ due (not "never again").
export function drillDue(s: RestoreDrillSetting, now: Date): boolean {
  if (!s.enabled) return false;
  const boundary = mostRecentWeeklyBoundary(now, s.dayOfWeek, s.hourLocal);
  if (!s.lastStartedAt) return true;
  const last = Date.parse(s.lastStartedAt);
  return !Number.isFinite(last) || last < boundary.getTime();
}

// --- integrity assertions (pure) -------------------------------------------------------------------
export type IntegritySnapshot = {
  tables: string[];                     // public-schema table names present
  rowCounts: Record<string, number>;    // KEY_TABLES -> count (missing table ⇒ 0)
  canaryClientsWithSystem: number;      // Clients joined to ≥1 ClientSystem
  orphanClientSystems: number;          // ClientSystem rows whose clientId has no Client
};

export type IntegrityVerdict = { ok: boolean; failures: string[] };

// The heart of the drill. Fails LOUDLY on a bad restore: a schema that dropped tables the live DB has,
// any key table that came back empty (the classic silent-bad-backup), a canary join that returns
// nothing, or an orphaned FK (a corrupt --no-owner restore can drop constraints/rows).
export function evaluateIntegrity(scratch: IntegritySnapshot, live: IntegritySnapshot): IntegrityVerdict {
  const failures: string[] = [];
  const missing = live.tables.filter((t) => !scratch.tables.includes(t));
  if (missing.length > 0) {
    failures.push(`restored schema is missing ${missing.length} table(s) present live: ${missing.slice(0, 6).join(", ")}`);
  }
  if (scratch.tables.length < KEY_TABLES.length) {
    failures.push(`restored schema has only ${scratch.tables.length} tables (expected ≥ ${KEY_TABLES.length})`);
  }
  for (const t of KEY_TABLES) {
    const n = scratch.rowCounts[t] ?? 0;
    if (!(n > 0)) failures.push(`key table ${t} restored empty (0 rows)`);
  }
  if (!(scratch.canaryClientsWithSystem > 0)) {
    failures.push("canary join returned no clients with a system — data is present but not queryable as expected");
  }
  if (scratch.orphanClientSystems > 0) {
    failures.push(`${scratch.orphanClientSystems} orphaned ClientSystem row(s) — a broken foreign key in the restore`);
  }
  return { ok: failures.length === 0, failures };
}

// --- orchestration (injectable) --------------------------------------------------------------------
export type AcquiredDump = { path: string; source: "local" | "blob"; checksumOk: boolean };

export type DrillDeps = {
  acquireDump: () => Promise<AcquiredDump>;
  liveDbName: string;
  scratchName: string; // the isolated target — asserted ≠ liveDbName before anything is created
  createScratch: (name: string) => Promise<void>;
  restore: (name: string, dumpPath: string) => Promise<void>; // MUST throw on any pg_restore error
  gatherScratch: (name: string) => Promise<IntegritySnapshot>;
  gatherLive: () => Promise<IntegritySnapshot>;
  dropScratch: (name: string) => Promise<void>; // best-effort teardown, always attempted
  now?: () => Date;
};

// Run one drill. Structured so EVERY failure mode (bad checksum, live==scratch guard, restore throws,
// empty/mismatched data) yields ok:false with a specific reason, and the scratch DB is dropped in a
// `finally` regardless. Never touches the live DB.
export async function runRestoreDrill(deps: DrillDeps): Promise<RestoreDrillResult> {
  const now = deps.now ?? (() => new Date());
  const at = now().toISOString();
  const startedMs = now().getTime();

  // Absolute safety rail: the drill must be incapable of touching the live DB.
  if (!deps.scratchName || deps.scratchName === deps.liveDbName) {
    return { ok: false, error: `refusing to run: scratch DB name (${deps.scratchName}) must differ from the live DB (${deps.liveDbName})`, at };
  }

  let acquired: AcquiredDump;
  try {
    acquired = await deps.acquireDump();
  } catch (err) {
    return { ok: false, error: sanitizeError(err instanceof Error ? err.message : String(err)), at };
  }
  if (!acquired.checksumOk) {
    return { ok: false, dumpUnderTest: acquired.path, source: acquired.source, checksumOk: false, at,
      error: "dump checksum did not match the recorded value — the off-box copy may be corrupt", durationMs: now().getTime() - startedMs };
  }

  let created = false;
  try {
    await deps.createScratch(deps.scratchName);
    created = true;
    await deps.restore(deps.scratchName, acquired.path); // throws on --exit-on-error failure
    const [scratch, live] = await Promise.all([deps.gatherScratch(deps.scratchName), deps.gatherLive()]);
    const verdict = evaluateIntegrity(scratch, live);
    return {
      ok: verdict.ok,
      dumpUnderTest: acquired.path,
      source: acquired.source,
      checksumOk: acquired.checksumOk,
      tables: scratch.tables.length,
      rowCounts: scratch.rowCounts,
      canaryOk: scratch.canaryClientsWithSystem > 0,
      orphanCount: scratch.orphanClientSystems,
      failures: verdict.failures,
      durationMs: now().getTime() - startedMs,
      scratchDb: deps.scratchName,
      error: verdict.ok ? undefined : verdict.failures.join("; "),
      at,
    };
  } catch (err) {
    return {
      ok: false,
      dumpUnderTest: acquired.path,
      source: acquired.source,
      checksumOk: acquired.checksumOk,
      durationMs: now().getTime() - startedMs,
      scratchDb: deps.scratchName,
      error: sanitizeError(err instanceof Error ? err.message : String(err)),
      at,
    };
  } finally {
    if (created) await deps.dropScratch(deps.scratchName).catch(() => {});
  }
}

// --- real Postgres deps ----------------------------------------------------------------------------
type PgUrls = { dbName: string; maintUrl: string; liveUrl: string; scratchUrl: (name: string) => string };

// Split DATABASE_URL exactly as runDbBackup does (drop only Prisma's ?schema=), yielding the pieces the
// drill needs: the live db name, a maintenance URL (…/postgres) for CREATE/DROP DATABASE, and a builder
// for the scratch DB URL. The connecting principal must have CREATEDB (restore.sh header states this).
export function pgUrlsFromEnv(rawUrl: string): PgUrls {
  const u = new URL(rawUrl);
  u.searchParams.delete("schema");
  const dbName = u.pathname.replace(/^\//, "") || "database";
  const base = new URL(u.toString());
  // mk copies the WHOLE url (host, port, credentials, query — sslmode/connect_timeout survive) and only
  // swaps the database name in the path.
  const mk = (name: string) => {
    const x = new URL(base.toString());
    x.pathname = `/${name}`;
    return x.toString();
  };
  return { dbName, maintUrl: mk("postgres"), liveUrl: base.toString(), scratchUrl: mk };
}

// A scratch name that is unique per run and can never collide with the live DB or a concurrent drill.
export function scratchDbName(dbName: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:.]/g, "").replace("T", "_").slice(0, 15);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${dbName}_drill_${stamp}_${rand}`;
}

async function psql(urls: string, sql: string, timeoutMs = 60_000): Promise<string> {
  const bin = findPgBin("psql");
  const { stdout } = await execFileP(bin, [urls, "--no-password", "-v", "ON_ERROR_STOP=1", "-qAt", "-c", sql], {
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.trim();
}

async function gatherFrom(urls: string): Promise<IntegritySnapshot> {
  const tablesRaw = await psql(urls, "SELECT string_agg(table_name, ',' ORDER BY table_name) FROM information_schema.tables WHERE table_schema = 'public'");
  const tables = tablesRaw ? tablesRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const rowCounts: Record<string, number> = {};
  for (const t of KEY_TABLES) {
    if (!tables.includes(t)) { rowCounts[t] = 0; continue; }
    try {
      const n = await psql(urls, `SELECT count(*) FROM "${t}"`);
      rowCounts[t] = Number(n) || 0;
    } catch {
      rowCounts[t] = 0;
    }
  }
  let canary = 0;
  let orphans = 0;
  if (tables.includes("Client") && tables.includes("ClientSystem")) {
    try {
      canary = Number(await psql(urls, 'SELECT count(DISTINCT c.id) FROM "Client" c JOIN "ClientSystem" cs ON cs."clientId" = c.id')) || 0;
    } catch { canary = 0; }
    try {
      orphans = Number(await psql(urls, 'SELECT count(*) FROM "ClientSystem" cs LEFT JOIN "Client" c ON cs."clientId" = c.id WHERE c.id IS NULL')) || 0;
    } catch { orphans = 0; }
  }
  return { tables, rowCounts, canaryClientsWithSystem: canary, orphanClientSystems: orphans };
}

// Build the real deps against DATABASE_URL. Prefers the Blob copy when Azure is configured (the truest
// test of the off-box path, §3.5); otherwise drills the local latest.dump.
export function pgDrillDeps(azure: AzureBackupConfig, localBackupDir: string, recordedChecksum?: string): DrillDeps {
  const rawUrl = process.env.DATABASE_URL ?? "";
  if (!rawUrl) throw new Error("DATABASE_URL is not set");
  const urls = pgUrlsFromEnv(rawUrl);
  const scratch = scratchDbName(urls.dbName);
  let tmpDownload: string | null = null;

  return {
    liveDbName: urls.dbName,
    scratchName: scratch,
    acquireDump: async () => {
      if (azureConfigured(azure)) {
        tmpDownload = path.join(os.tmpdir(), `${scratch}.dump`);
        const dl = await downloadLatestBlob(azure, urls.dbName, tmpDownload);
        // Verify the downloaded blob against the checksum recorded at upload time, when we have one.
        let checksumOk = true;
        if (recordedChecksum) checksumOk = (await sha256File(dl.localPath)) === recordedChecksum;
        return { path: dl.localPath, source: "blob", checksumOk };
      }
      const local = path.join(localBackupDir, "latest.dump");
      await fs.access(local); // throws if no local dump exists
      return { path: local, source: "local", checksumOk: true };
    },
    createScratch: async (name) => { await psql(urls.maintUrl, `CREATE DATABASE "${name}"`); },
    restore: async (name, dumpPath) => {
      const pgRestore = findPgBin("pg_restore");
      // --exit-on-error is the whole point: pg_restore's default continues past object errors, which
      // would let a partial/corrupt restore look complete. A truncated dump throws here.
      await execFileP(pgRestore, ["--no-password", "--no-owner", "--no-privileges", "--exit-on-error", `--dbname=${urls.scratchUrl(name)}`, dumpPath], {
        timeout: 10 * 60_000,
      });
    },
    gatherScratch: (name) => gatherFrom(urls.scratchUrl(name)),
    gatherLive: () => gatherFrom(urls.liveUrl),
    dropScratch: async (name) => {
      try {
        await psql(urls.maintUrl, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`);
      } catch { /* best-effort */ }
      await psql(urls.maintUrl, `DROP DATABASE IF EXISTS "${name}"`);
      if (tmpDownload) await fs.rm(tmpDownload, { force: true }).catch(() => {});
    },
  };
}

// --- staleness alert (pure) ------------------------------------------------------------------------
// ">26h without a backup" (§3.7): closes the gap where NO backup ran at all — which today produces no
// failure, because nothing ran to fail. Throttled to once per ~24h via lastStaleAlertAt so a persistent
// stall doesn't spam chat every minute.
export function computeStalenessAlert(
  backupStale: boolean,
  lastStaleAlertAt: string | undefined,
  now: Date,
): { shouldAlert: boolean } {
  if (!backupStale) return { shouldAlert: false };
  if (!lastStaleAlertAt) return { shouldAlert: true };
  const last = Date.parse(lastStaleAlertAt);
  if (!Number.isFinite(last)) return { shouldAlert: true };
  return { shouldAlert: now.getTime() - last > 24 * 3_600_000 };
}

// --- the heartbeat-driven sweep --------------------------------------------------------------------
let lastTickAt = 0;
const TICK_EVERY_MS = 60_000;

// Never throws (fire-and-forget off the heartbeat handler), mirroring sweepDbBackup.
export async function sweepRestoreDrill(db: PrismaClient): Promise<void> {
  const tick = Date.now();
  if (tick - lastTickAt < TICK_EVERY_MS) return;
  lastTickAt = tick;

  const now = new Date();

  // 1) Staleness watch runs every eligible tick regardless of whether the drill itself is due — it is
  //    the "no backup ran at all" safety net. Fire at most once per 24h.
  const drillRaw = await getAppSetting<unknown>(db, DRILL_KEY);
  const drill = normalizeDrill(drillRaw);
  const fresh = await backupFreshness(db, now).catch(() => null);
  if (fresh) {
    const { shouldAlert } = computeStalenessAlert(fresh.backupStale, drill.lastStaleAlertAt, now);
    if (shouldAlert) {
      await fireNotification({
        event: "backupFailed",
        title: "No fresh database backup",
        detail: fresh.lastBackupAt
          ? `The last successful backup was ${fresh.backupAgeHours?.toFixed(0)}h ago (stale past ${26}h). No backup may be running.`
          : "No successful database backup has ever been recorded. Backups may not be running.",
        at: now.toISOString(),
      }).catch(() => {});
      // Merge-write the throttle stamp without clobbering a concurrent operator edit.
      const cur = normalizeDrill(await getAppSetting<unknown>(db, DRILL_KEY));
      await setAppSetting(db, DRILL_KEY, { ...cur, lastStaleAlertAt: now.toISOString() });
    }
  }

  // 2) The drill itself, on its weekly boundary.
  if (!drillDue(drill, now)) return;
  const claimed: RestoreDrillSetting = { ...drill, lastStartedAt: now.toISOString() };
  if (!(await claimAppSetting(db, DRILL_KEY, drillRaw, claimed))) return;

  const azure = await loadAzureBackup(db);
  const backup: DbBackupSetting = normalizeDbBackup(await getAppSetting<unknown>(db, DB_BACKUP_KEY));
  const recordedChecksum = backup.lastResult?.checksum;

  let result: RestoreDrillResult;
  try {
    result = await runRestoreDrill(pgDrillDeps(azure, backup.backupDir, recordedChecksum));
  } catch (err) {
    result = { ok: false, error: sanitizeError(err instanceof Error ? err.message : String(err)), at: now.toISOString() };
  }

  // Merge-write the result (a racing operator toggle must survive).
  const cur = normalizeDrill(await getAppSetting<unknown>(db, DRILL_KEY));
  await setAppSetting(db, DRILL_KEY, { ...cur, lastResult: result });

  await db.auditLog
    .create({ data: { actor: "system:restore-drill", action: result.ok ? "db.restore_drill.completed" : "db.restore_drill.failed", detail: { ...result } } })
    .catch(() => {});

  if (!result.ok) {
    await fireNotification({
      event: "backupFailed",
      title: "Database restore drill FAILED",
      detail: `The scheduled restore drill could not prove the latest dump is restorable: ${result.error ?? "unknown error"}`,
      at: result.at,
    }).catch(() => {});
  }
}

// The operator-facing projection of the drill setting (admin route + settings card).
export type RestoreDrillStatus = {
  enabled: boolean;
  dayOfWeek: number;
  hourLocal: number;
  lastStartedAt: string | null;
  lastResult: RestoreDrillResult | null;
};

export function restoreDrillStatus(raw: unknown): RestoreDrillStatus {
  const s = normalizeDrill(raw);
  return {
    enabled: s.enabled,
    dayOfWeek: s.dayOfWeek,
    hourLocal: s.hourLocal,
    lastStartedAt: s.lastStartedAt ?? null,
    lastResult: s.lastResult ?? null,
  };
}
