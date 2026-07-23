// "Build schema" for the db-copy tool: run `prisma migrate deploy` against the DESTINATION so its
// schema (tables, enum types, indexes, constraints) is created natively by Prisma — the piece a
// managed Postgres like Azure won't let a plain restore create. Runs on the app server (which has the
// prisma CLI + prisma/migrations on disk); the destination password is passed only via the child's
// DATABASE_URL env and scrubbed from all output. `migrate deploy` applies committed migrations only —
// it never resets the database or needs a shadow DB.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { sanitizeError } from "@/lib/jobs/db-backup";
import type { PgConn } from "./config";

export type MigrateResult = { ok: boolean; output: string };

/** Build the destination DATABASE_URL. Credentials are URL-encoded so passwords with @ : / ? # survive. */
export function destDatabaseUrl(conn: PgConn): string {
  const user = encodeURIComponent(conn.user);
  const pass = encodeURIComponent(conn.password);
  const db = encodeURIComponent(conn.database);
  const params = new URLSearchParams({ schema: conn.schema });
  if (conn.sslmode === "require") params.set("sslmode", "require");
  return `postgresql://${user}:${pass}@${conn.host}:${conn.port}/${db}?${params.toString()}`;
}

/** Remove the destination password (literal, URL-encoded, or in a connection URL) from captured output. */
export function scrubMigrateOutput(output: string, conn: PgConn): string {
  let s = output;
  if (conn.password) {
    s = s.split(conn.password).join("***"); // literal FIRST (password may contain @, which the URL regex splits on)
    s = s.split(encodeURIComponent(conn.password)).join("***"); // and the URL-encoded form
  }
  return sanitizeError(s);
}

function prismaBin(): string {
  const local = path.join(process.cwd(), "node_modules", ".bin", "prisma");
  return existsSync(local) ? local : "prisma";
}

/** Run `prisma migrate deploy` against the destination. Never throws — returns { ok, output(scrubbed) }. */
export async function runPrismaMigrateDeploy(conn: PgConn): Promise<MigrateResult> {
  const url = destDatabaseUrl(conn);
  return new Promise<MigrateResult>((resolve) => {
    const child = spawn(prismaBin(), ["migrate", "deploy"], {
      cwd: process.cwd(), // the web/ app dir, where prisma/schema.prisma + migrations live
      env: { ...process.env, DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("error", (e) => resolve({ ok: false, output: scrubMigrateOutput(`failed to start prisma: ${e.message}`, conn) }));
    child.on("close", (code) => resolve({ ok: code === 0, output: scrubMigrateOutput(out.trim(), conn) }));
  });
}
