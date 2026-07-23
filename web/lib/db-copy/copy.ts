// DB-copy tool — runtime orchestration. Makes the destination (POSTGRES_*1) a faithful copy of the
// source (POSTGRES_*):
//   1. list source tables (public-schema base tables, minus Prisma's _prisma_migrations ledger);
//   2. for tables MISSING in the destination: pg_dump --schema-only (one call → correct FK/sequence
//      ordering, indexes + constraints + defaults included) piped into the dest;
//   3. for tables that ALREADY exist: TRUNCATE … RESTART IDENTITY CASCADE (the "replace" choice);
//   4. load all data: pg_dump --data-only --disable-triggers piped in (FK checks off during bulk load,
//      so cross-table ordering and self-references can't fail).
// Credentials go to pg_dump/psql via PG* env (see pgChildEnv) so the password never lands in argv.
import { spawn } from "node:child_process";
import { Client } from "pg";
import { findPgBin, sanitizeError } from "@/lib/jobs/db-backup";
import { type PgConn, pgChildEnv, connLabel, sameTarget, pgSsl } from "./config";
import { classifyTables, shortVersion, PG_DUMP_BASE } from "./plan";
import { dumpLineFilter } from "./dump-filter";

// Prisma's migration ledger — copying it would stamp the destination with the source's migration
// history and can desync a separately-managed dest. Excluded from "all tables" by default.
const EXCLUDED_TABLES = new Set(["_prisma_migrations"]);

async function withClient<T>(conn: PgConn, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ host: conn.host, port: conn.port, user: conn.user, password: conn.password, database: conn.database, ssl: pgSsl(conn) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

/** Base tables in the schema, excluding the Prisma ledger, sorted for a stable display order. */
async function listTables(client: Client, schema: string): Promise<string[]> {
  const { rows } = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = $1 AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
    [schema],
  );
  return rows.map((r) => r.table_name).filter((t) => !EXCLUDED_TABLES.has(t));
}

/** Approximate row counts (pg_class.reltuples — fast, no full scan) for the preview. */
async function approxRowCounts(client: Client, schema: string): Promise<Map<string, number>> {
  const { rows } = await client.query<{ relname: string; n: string }>(
    `SELECT c.relname, c.reltuples::bigint AS n
       FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = $1 AND c.relkind = 'r'`,
    [schema],
  );
  return new Map(rows.map((r) => [r.relname, Math.max(0, Number(r.n))]));
}

export type ConnHealth = { ok: boolean; label: string; server?: string; tableCount?: number; error?: string };

/**
 * Independently test connectivity to one database: connect, read the server version, and count its
 * base tables. Never throws — a failure is reported as { ok:false, error } (password scrubbed) so the
 * caller can show per-database status even when the other side is down.
 */
export async function checkConnection(conn: PgConn): Promise<ConnHealth> {
  const client = new Client({ host: conn.host, port: conn.port, user: conn.user, password: conn.password, database: conn.database, ssl: pgSsl(conn) });
  try {
    await client.connect();
    const v = await client.query<{ version: string }>("SELECT version() AS version");
    const t = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
      [conn.schema],
    );
    return { ok: true, label: connLabel(conn), server: shortVersion(v.rows[0]?.version), tableCount: Number(t.rows[0]?.n ?? 0) };
  } catch (e) {
    return { ok: false, label: connLabel(conn), error: sanitizeError(e instanceof Error ? e.message : String(e)) };
  } finally {
    await client.end().catch(() => {});
  }
}

export type ConnHealthPair = { source: ConnHealth; dest: ConnHealth };

/** Health-test BOTH databases (source and destination) in parallel. */
export async function checkConnections(source: PgConn, dest: PgConn): Promise<ConnHealthPair> {
  const [src, dst] = await Promise.all([checkConnection(source), checkConnection(dest)]);
  return { source: src, dest: dst };
}

export type TablePreview = { name: string; inDest: boolean; approxRows: number };
export type CopyPreview = {
  sourceLabel: string;
  destLabel: string;
  sameTarget: boolean;
  destDbName: string;
  tables: TablePreview[];
  missingCount: number;
  existingCount: number;
};

/** Read-only look at what a copy would do: source→dest identities + per-table presence & est. rows. */
export async function previewCopy(source: PgConn, dest: PgConn): Promise<CopyPreview> {
  const same = sameTarget(source, dest);
  const [srcTables, srcCounts] = await withClient(source, async (c) => [await listTables(c, source.schema), await approxRowCounts(c, source.schema)] as const);
  const destTables = same ? new Set(srcTables) : await withClient(dest, (c) => listTables(c, dest.schema).then((t) => new Set(t)));
  const plan = classifyTables(srcTables, destTables);
  return {
    sourceLabel: connLabel(source),
    destLabel: connLabel(dest),
    sameTarget: same,
    destDbName: dest.database,
    tables: srcTables.map((name) => ({ name, inDest: destTables.has(name), approxRows: srcCounts.get(name) ?? 0 })),
    missingCount: plan.missing.length,
    existingCount: plan.existing.length,
  };
}

/** Pipe `pg_dump <dumpArgs>` (from source) straight into `psql -f -` (on dest). Rejects on either failure. */
function dumpIntoDest(dumpArgs: string[], source: PgConn, dest: PgConn): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const dump = spawn(findPgBin("pg_dump"), ["--no-password", ...PG_DUMP_BASE, ...dumpArgs], { env: pgChildEnv(source) });
    const load = spawn(findPgBin("psql"), ["--no-password", "-v", "ON_ERROR_STOP=1", "--single-transaction", "-q", "-f", "-"], { env: pgChildEnv(dest) });
    let dumpErr = "";
    let loadErr = "";
    let settled = false;
    const fail = (msg: string) => { if (!settled) { settled = true; reject(new Error(sanitizeError(msg))); } };

    dump.stderr.on("data", (d) => (dumpErr += d.toString()));
    load.stderr.on("data", (d) => (loadErr += d.toString()));
    dump.on("error", (e) => fail(`pg_dump failed to start: ${e.message}`));
    load.on("error", (e) => fail(`psql failed to start: ${e.message}`));
    // Filter the stream so GUCs the (possibly older) destination doesn't recognize — e.g. the PG17+
    // `transaction_timeout` pg_dump 17+ emits — are dropped before psql sees them.
    const filter = dumpLineFilter();
    filter.on("error", (e) => fail(`dump filter failed: ${e.message}`));
    dump.stdout.pipe(filter).pipe(load.stdin);

    let dumpDone = false;
    let loadDone = false;
    const maybeDone = () => {
      if (settled || !dumpDone || !loadDone) return;
      settled = true;
      resolvePromise();
    };
    dump.on("close", (code) => {
      if (code !== 0) return fail(`pg_dump exited ${code}: ${dumpErr.trim()}`);
      dumpDone = true;
      maybeDone();
    });
    load.on("close", (code) => {
      if (code !== 0) return fail(`psql exited ${code}: ${loadErr.trim() || dumpErr.trim()}`);
      loadDone = true;
      maybeDone();
    });
  });
}

export type CopyResult = {
  tables: number;
  durationMs: number;
};

/**
 * pg_dump flags for a whole-database CLONE: drop + recreate everything the source has — custom types
 * (enums), tables, sequences, constraints, indexes — and load all data, in one dependency-ordered pass.
 * `--clean --if-exists` makes it idempotent (DROP … IF EXISTS before CREATE). PG_DUMP_BASE adds
 * --no-owner --no-privileges so it restores under the destination login regardless of source roles.
 * This replaced the per-table -t approach, which omitted enum types the tables depend on.
 */
export function fullCopyDumpArgs(): string[] {
  return ["--clean", "--if-exists"];
}

/** Audit detail for a copy attempt: WHERE it went (source→dest identity, never a password) + outcome.
 * Any error string is scrubbed of both connection passwords. */
export function copyAuditDetail(
  source: PgConn,
  dest: PgConn,
  extra: { ok: boolean; tables?: number; durationMs?: number; error?: string },
): { source: string; dest: string; ok: boolean; tables?: number; durationMs?: number; error?: string } {
  const scrub = (m: string) => {
    let s = sanitizeError(m);
    for (const pw of [source.password, dest.password]) if (pw) s = s.split(pw).join("***");
    return s;
  };
  return {
    source: `${source.host}:${source.port}/${source.database}`,
    dest: `${dest.host}:${dest.port}/${dest.database}`,
    ok: extra.ok,
    ...(extra.tables != null ? { tables: extra.tables } : {}),
    ...(extra.durationMs != null ? { durationMs: extra.durationMs } : {}),
    ...(extra.error != null ? { error: scrub(extra.error) } : {}),
  };
}

export type CopyProgress = (phase: string) => void;

/** Execute the copy. Throws on any failure (with the password scrubbed from the message). */
export async function runCopy(source: PgConn, dest: PgConn, onProgress: CopyProgress = () => {}): Promise<CopyResult> {
  if (sameTarget(source, dest)) throw new Error("source and destination are the same database — refusing to copy onto itself");
  const startedAt = Date.now();

  onProgress("reading source tables");
  const srcTables = await withClient(source, (c) => listTables(c, source.schema));
  if (!srcTables.length) throw new Error(`source schema "${source.schema}" has no tables to copy`);

  // One whole-database dump→restore: drops + recreates every object (types, tables, sequences,
  // constraints) and reloads data in the correct dependency order. Correct for a fresh migration and
  // idempotent on re-runs. The pipe strips the transaction_timeout GUC an older destination rejects.
  onProgress(`cloning the whole database (${srcTables.length} table(s)): drop + recreate types, tables and data`);
  await dumpIntoDest(fullCopyDumpArgs(), source, dest);

  return { tables: srcTables.length, durationMs: Date.now() - startedAt };
}
