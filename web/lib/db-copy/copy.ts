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
import { type PgConn, pgChildEnv, connLabel, sameTarget } from "./config";
import { classifyTables, dumpTableArgs, truncateStatement, shortVersion, PG_DUMP_BASE, type TablePlan } from "./plan";

// Prisma's migration ledger — copying it would stamp the destination with the source's migration
// history and can desync a separately-managed dest. Excluded from "all tables" by default.
const EXCLUDED_TABLES = new Set(["_prisma_migrations"]);

async function withClient<T>(conn: PgConn, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ host: conn.host, port: conn.port, user: conn.user, password: conn.password, database: conn.database });
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
  const client = new Client({ host: conn.host, port: conn.port, user: conn.user, password: conn.password, database: conn.database });
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
    dump.stdout.pipe(load.stdin);

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
  totalTables: number;
  createdTables: string[];
  truncatedTables: string[];
  durationMs: number;
};

export type CopyProgress = (phase: string) => void;

/** Execute the copy. Throws on any failure (with the password scrubbed from the message). */
export async function runCopy(source: PgConn, dest: PgConn, onProgress: CopyProgress = () => {}): Promise<CopyResult> {
  if (sameTarget(source, dest)) throw new Error("source and destination are the same database — refusing to copy onto itself");
  const startedAt = Date.now();

  onProgress("reading source + destination tables");
  const srcTables = await withClient(source, (c) => listTables(c, source.schema));
  if (!srcTables.length) throw new Error(`source schema "${source.schema}" has no tables to copy`);
  const destTables = await withClient(dest, (c) => listTables(c, dest.schema).then((t) => new Set(t)));
  const plan: TablePlan = classifyTables(srcTables, destTables);

  if (plan.missing.length) {
    onProgress(`creating ${plan.missing.length} missing table(s) in the destination`);
    await dumpIntoDest(["--schema-only", ...dumpTableArgs(source.schema, plan.missing)], source, dest);
  }

  const truncate = truncateStatement(dest.schema, plan.existing);
  if (truncate) {
    onProgress(`truncating ${plan.existing.length} existing table(s) before reload`);
    await withClient(dest, (c) => c.query(truncate));
  }

  onProgress(`copying data for ${plan.all.length} table(s)`);
  await dumpIntoDest(["--data-only", "--disable-triggers", ...dumpTableArgs(source.schema, plan.all)], source, dest);

  return {
    totalTables: plan.all.length,
    createdTables: plan.missing,
    truncatedTables: plan.existing,
    durationMs: Date.now() - startedAt,
  };
}
