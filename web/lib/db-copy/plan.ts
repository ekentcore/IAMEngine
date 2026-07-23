// DB-copy tool — pure planning helpers (no DB / no child_process), so the identifier quoting and
// command construction are unit-testable. The runtime orchestration in copy.ts calls these.

/** Double-quote a Postgres identifier, escaping embedded quotes. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Fully-qualified, quoted "schema"."table". */
export function qualified(schema: string, table: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

/**
 * pg_dump `-t` value for one table. pg_dump matches -t as a pattern; a double-quoted identifier is
 * matched literally (case-sensitive), which we need for Prisma's PascalCase table names ("Client").
 * Returns e.g. `public."Client"`.
 */
export function dumpTableArg(schema: string, table: string): string {
  return `${schema}.${quoteIdent(table)}`;
}

/** Flatten a table list into the alternating `-t <arg>` argv pieces for pg_dump. */
export function dumpTableArgs(schema: string, tables: string[]): string[] {
  return tables.flatMap((t) => ["-t", dumpTableArg(schema, t)]);
}

/** `TRUNCATE "s"."a", "s"."b" RESTART IDENTITY CASCADE;` — empty list → null (nothing to truncate). */
export function truncateStatement(schema: string, tables: string[]): string | null {
  if (!tables.length) return null;
  const list = tables.map((t) => qualified(schema, t)).join(", ");
  return `TRUNCATE ${list} RESTART IDENTITY CASCADE;`;
}

export type TablePlan = {
  /** Every in-scope source table, in the order returned by the source. */
  all: string[];
  /** Tables absent from the destination — created (schema-only) before the data load. */
  missing: string[];
  /** Tables already present in the destination — truncated, then reloaded (the "replace" choice). */
  existing: string[];
};

/** Split source tables into missing/existing against the destination's table set. */
export function classifyTables(sourceTables: string[], destTables: Set<string>): TablePlan {
  const missing: string[] = [];
  const existing: string[] = [];
  for (const t of sourceTables) (destTables.has(t) ? existing : missing).push(t);
  return { all: sourceTables, missing, existing };
}

/** Shared pg_dump flags: no ownership/ACL noise (dest role may differ), fail loudly on bad input. */
export const PG_DUMP_BASE = ["--no-owner", "--no-privileges"] as const;
