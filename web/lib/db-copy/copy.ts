// DB-copy tool — runtime orchestration. Copies the DATA from the source (POSTGRES_*) into the
// destination's EXISTING schema (POSTGRES_*1). The destination schema is built separately by
// `prisma migrate deploy` — so this tool never emits schema DDL, which is what a managed Postgres
// (Azure) withholds from its admin login (schema/type ownership, superuser triggers). Steps:
//   1. list source tables (base tables, minus Prisma's _prisma_migrations ledger);
//   2. verify the destination already has those tables (else: "run prisma migrate deploy first");
//   3. TRUNCATE … RESTART IDENTITY CASCADE the destination tables (their owner can, no superuser);
//   4. load data: pg_dump --data-only piped in (no --disable-triggers; TRUNCATE + pg_dump's
//      dependency ordering keep the load FK-clean without needing superuser).
// Credentials go to pg_dump/psql via PG* env (see pgChildEnv) so the password never lands in argv.
import { spawn } from "node:child_process";
import { Client } from "pg";
import { findPgBin, sanitizeError } from "@/lib/jobs/db-backup";
import { type PgConn, pgChildEnv, connLabel, sameTarget, pgSsl } from "./config";
import { classifyTables, dumpTableArgs, truncateStatement, shortVersion, PG_DUMP_BASE, qualified } from "./plan";
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

/** EXACT row counts (SELECT count(*)) per table — unlike approxRowCounts (pg_class.reltuples), these
 * are real and don't read 0 right after a restore before ANALYZE runs. Used by the Compare feature. */
async function exactRowCounts(client: Client, schema: string, tables: string[]): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  for (const t of tables) {
    const { rows } = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${qualified(schema, t)}`);
    m.set(t, Number(rows[0]?.n ?? 0));
  }
  return m;
}

export type TableComparison = { table: string; sourceRows: number | null; destRows: number | null; match: boolean };
export type ComparisonResult = { sourceLabel: string; destLabel: string; rows: TableComparison[]; allMatch: boolean; mismatches: number };

/** Pure: join source & destination row-count maps into a per-table comparison (union of both sides). */
export function buildComparison(source: Map<string, number>, dest: Map<string, number>): { rows: TableComparison[]; allMatch: boolean; mismatches: number } {
  const names = Array.from(new Set([...source.keys(), ...dest.keys()])).sort();
  const rows: TableComparison[] = names.map((table) => {
    const sourceRows = source.has(table) ? source.get(table)! : null;
    const destRows = dest.has(table) ? dest.get(table)! : null;
    return { table, sourceRows, destRows, match: sourceRows !== null && destRows !== null && sourceRows === destRows };
  });
  const mismatches = rows.filter((r) => !r.match).length;
  return { rows, allMatch: mismatches === 0, mismatches };
}

/** Compare source vs destination by EXACT per-table row counts (excludes the Prisma ledger). Read-only. */
export async function compareTables(source: PgConn, dest: PgConn): Promise<ComparisonResult> {
  const srcCounts = await withClient(source, async (c) => exactRowCounts(c, source.schema, await listTables(c, source.schema)));
  const destCounts = await withClient(dest, async (c) => exactRowCounts(c, dest.schema, await listTables(c, dest.schema)));
  const { rows, allMatch, mismatches } = buildComparison(srcCounts, destCounts);
  return { sourceLabel: connLabel(source), destLabel: connLabel(dest), rows, allMatch, mismatches };
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
 * pg_dump flags for a DATA-ONLY load into a schema that already exists on the destination (built by
 * `prisma migrate deploy`). No schema DDL, so it never touches type/table/`public`-schema ownership —
 * which is what a managed Postgres like Azure withholds from the admin login. Deliberately NO
 * `--disable-triggers`: that emits `ALTER TABLE … DISABLE TRIGGER ALL`, which needs superuser Azure
 * doesn't grant. We rely on the destination being TRUNCATEd first and pg_dump's dependency ordering
 * for a clean load. Restricted to the given tables via -t; PG_DUMP_BASE adds --no-owner --no-privileges.
 */
export function dataCopyDumpArgs(schema: string, tables: string[]): string[] {
  return ["--data-only", ...dumpTableArgs(schema, tables)];
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

/**
 * Copy the DATA from source into the destination's EXISTING schema (created by `prisma migrate deploy`
 * on the destination). Steps: verify the destination already has the source's tables (else tell the
 * operator to run the migration first), TRUNCATE them, then load data-only. No schema DDL is emitted,
 * so it never trips managed-Postgres restrictions (schema/type ownership, superuser triggers). Throws
 * on any failure (password scrubbed from the message).
 */
export async function runCopy(source: PgConn, dest: PgConn, onProgress: CopyProgress = () => {}): Promise<CopyResult> {
  if (sameTarget(source, dest)) throw new Error("source and destination are the same database — refusing to copy onto itself");
  const startedAt = Date.now();

  onProgress("reading source + destination tables");
  const srcTables = await withClient(source, (c) => listTables(c, source.schema));
  if (!srcTables.length) throw new Error(`source schema "${source.schema}" has no tables to copy`);
  const destTables = await withClient(dest, (c) => listTables(c, dest.schema).then((t) => new Set(t)));

  // The destination schema must already exist. If tables are missing, the operator hasn't run the
  // migration on the destination yet — say so explicitly rather than failing mid-load.
  const plan = classifyTables(srcTables, destTables);
  if (plan.missing.length) {
    const sample = plan.missing.slice(0, 5).join(", ");
    throw new Error(
      `destination schema "${dest.schema}" is missing ${plan.missing.length} of ${srcTables.length} table(s) ` +
        `(e.g. ${sample}). Build the schema on the destination first — run \`prisma migrate deploy\` against it — ` +
        `then copy the data.`,
    );
  }

  // Empty the destination tables (as their owner — no superuser needed), then bulk-load the data.
  const truncate = truncateStatement(dest.schema, plan.all);
  if (truncate) {
    onProgress(`clearing ${plan.all.length} destination table(s) before load`);
    await withClient(dest, (c) => c.query(truncate));
  }

  onProgress(`copying data for ${plan.all.length} table(s)`);
  await dumpIntoDest(dataCopyDumpArgs(source.schema, plan.all), source, dest);

  return { tables: plan.all.length, durationMs: Date.now() - startedAt };
}
