// Go-live check #6a: "does the DB schema match the code we deployed?" The migration files ship in the
// bundle, so a mismatch means the Azure deploy pushed code ahead of (or behind) the database.
//
// Deliberately NOT `prisma migrate status` — that needs the Prisma CLI + a query engine on the host,
// which is unreliable under the Azure app runtime. Instead: a cheap raw read of `_prisma_migrations`
// diffed against the shipped `prisma/migrations/` directory (same readdir style as lib/runner/bundle).
// The diff is a pure function so it unit-tests without a DB.
import type { PrismaClient } from "@prisma/client";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

// Where the shipped migrations live, relative to the web/ working directory (process.cwd() is web/).
export const MIGRATIONS_DIR = resolve(process.cwd(), "prisma", "migrations");

// One `_prisma_migrations` row, reduced to what the diff needs. A row is APPLIED when it finished and
// was not rolled back.
export type AppliedMigrationRow = { migration_name: string; finished_at: Date | null; rolled_back_at: Date | null };

export type MigrationStatus = {
  verdict: "pass" | "warn" | "fail";
  expected: number; // migration directories shipped in the bundle
  applied: number; // of those, how many are applied in the DB
  missing: string[]; // expected but not present-and-applied in the DB (schema is BEHIND code)
  rolledBack: string[]; // expected migrations whose DB row was rolled back / never finished
  detail: string;
};

// The migration names the deployed code expects — every subdirectory of prisma/migrations/ (each is a
// migration). Excludes migration_lock.toml (a file) and any dot-entry. Sorted for a stable detail line.
export function readExpectedMigrations(dir: string = MIGRATIONS_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

// Pure diff: every expected migration must exist in the DB, be finished, and not be rolled back.
// - expected count 0  -> warn (nothing to verify — unreadable directory or a broken bundle)
// - any expected migration missing from the DB, or unfinished, or rolled back -> fail
// - otherwise -> pass
export function diffMigrations(expected: string[], appliedRows: AppliedMigrationRow[]): MigrationStatus {
  const byName = new Map(appliedRows.map((r) => [r.migration_name, r]));
  const missing: string[] = [];
  const rolledBack: string[] = [];
  let applied = 0;
  for (const name of expected) {
    const row = byName.get(name);
    if (!row || row.finished_at === null) {
      missing.push(name);
    } else if (row.rolled_back_at !== null) {
      rolledBack.push(name);
    } else {
      applied++;
    }
  }

  if (expected.length === 0) {
    return { verdict: "warn", expected: 0, applied: 0, missing, rolledBack, detail: "could not read any shipped migrations to verify schema state" };
  }
  if (missing.length > 0 || rolledBack.length > 0) {
    const parts: string[] = [];
    if (missing.length) parts.push(`${missing.length} not applied (${missing.slice(0, 3).join(", ")}${missing.length > 3 ? "…" : ""})`);
    if (rolledBack.length) parts.push(`${rolledBack.length} rolled back (${rolledBack.slice(0, 3).join(", ")}${rolledBack.length > 3 ? "…" : ""})`);
    return { verdict: "fail", expected: expected.length, applied, missing, rolledBack, detail: `schema out of sync: ${parts.join("; ")}` };
  }
  return { verdict: "pass", expected: expected.length, applied, missing, rolledBack, detail: `all ${expected.length} migrations applied` };
}

// DB-backed entry point: read the applied set + the shipped set, diff them. An unreadable
// `_prisma_migrations` table (or a directory read error) never false-passes — it degrades to warn.
export async function migrationStatus(db: PrismaClient, dir: string = MIGRATIONS_DIR): Promise<MigrationStatus> {
  let expected: string[];
  try {
    expected = readExpectedMigrations(dir);
  } catch {
    expected = [];
  }
  let rows: AppliedMigrationRow[];
  try {
    rows = await db.$queryRaw<AppliedMigrationRow[]>`
      SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations
    `;
  } catch (e) {
    return {
      verdict: "warn",
      expected: expected.length,
      applied: 0,
      missing: expected,
      rolledBack: [],
      detail: `could not read _prisma_migrations: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  return diffMigrations(expected, rows);
}
