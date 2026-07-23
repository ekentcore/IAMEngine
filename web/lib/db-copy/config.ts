// DB-copy tool — connection config. The SOURCE database is described by the usual POSTGRES_* vars
// (the same set read-env.mjs / sync-env.mjs use to build DATABASE_URL); the DESTINATION is the same
// set with a "1" suffix (POSTGRES_HOST1, POSTGRES_USER1, …). These live in the repo-root env.env and
// are NOT exposed to the Next runtime (sync-env CONSUMES them into DATABASE_URL), so we read env.env
// directly here — the same way the db scripts do.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// TLS mode for the connection. Kept binary for now (the form is a toggle): "require" encrypts and is
// mandatory for managed Postgres like Azure ("no pg_hba.conf entry … SSL off"); "disable" is plaintext
// (fine for a trusted LAN source). Stored as a string so a fuller sslmode set (verify-full, …) can be
// added later without a shape change.
export type SslMode = "disable" | "require";

export type PgConn = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  schema: string;
  sslmode: SslMode;
};

/** Coerce arbitrary input to a known SslMode. Only "require" (case-insensitive) enables TLS. */
export function normalizeSslMode(raw: unknown): SslMode {
  return typeof raw === "string" && raw.trim().toLowerCase() === "require" ? "require" : "disable";
}

/**
 * node-postgres `ssl` option for a connection. "require" → TLS on, without local CA verification
 * (rejectUnauthorized:false) — matches sslmode=require semantics and works against Azure without
 * shipping a CA bundle. "disable" → no TLS.
 */
export function pgSsl(conn: PgConn): false | { rejectUnauthorized: boolean } {
  return conn.sslmode === "require" ? { rejectUnauthorized: false } : false;
}

// Ported from scripts/read-env.mjs (KEY="value" lines, no shell expansion, tolerant of trailing
// comments + the "@Header" lines). Kept local so the Next server bundle doesn't reach into scripts/.
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("@")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    const quoted = /^(["'])([\s\S]*?)\1\s*(?:#.*)?$/.exec(value);
    if (quoted) value = quoted[2];
    else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value; // later wins
  }
  return out;
}

// Candidate locations for env.env: the app runs from web/ (so ../env.env is the repo root), but fall
// back to CWD in case it's invoked elsewhere.
function readEnvEnv(): Record<string, string> {
  const candidates = [resolve(process.cwd(), "..", "env.env"), resolve(process.cwd(), "env.env")];
  for (const p of candidates) {
    try {
      return parseEnvFile(readFileSync(p, "utf8"));
    } catch {
      /* try next */
    }
  }
  throw new Error(`could not read env.env (looked in: ${candidates.join(", ")})`);
}

// The six connection fields and their env-var base names. The destination uses the same names + "1".
const FIELDS = ["HOST", "PORT", "USER", "PASSWORD", "DB", "SCHEMA"] as const;

/** Build a PgConn from an env map for a given suffix ("" = source, "1" = destination). */
export function connFromEnv(env: Record<string, string>, suffix: "" | "1"): { conn: PgConn | null; missing: string[] } {
  const v = (base: string) => env[`POSTGRES_${base}${suffix}`]?.replace(/^"|"$/g, "").trim() || "";
  const required = ["HOST", "USER", "PASSWORD", "DB"];
  const missing = required.filter((b) => !v(b)).map((b) => `POSTGRES_${b}${suffix}`);
  if (missing.length) return { conn: null, missing };
  return {
    conn: {
      host: v("HOST"),
      port: Number(v("PORT")) || 5432,
      user: v("USER"),
      password: v("PASSWORD"),
      database: v("DB"),
      schema: v("SCHEMA") || "public",
      sslmode: normalizeSslMode(v("SSLMODE")),
    },
    missing: [],
  };
}

export type CopyConfigResult = {
  source: PgConn | null;
  dest: PgConn | null;
  missingSource: string[];
  missingDest: string[];
};

/** Read env.env and resolve both connections. Never throws for missing vars — reports them instead. */
export function readCopyConfigs(): CopyConfigResult {
  const env = readEnvEnv();
  const s = connFromEnv(env, "");
  const d = connFromEnv(env, "1");
  return { source: s.conn, dest: d.conn, missingSource: s.missing, missingDest: d.missing };
}

/** PG* environment for a pg_dump/psql child process — keeps the password out of argv (and out of `ps`). */
export function pgChildEnv(conn: PgConn): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PGHOST: conn.host,
    PGPORT: String(conn.port),
    PGUSER: conn.user,
    PGPASSWORD: conn.password,
    PGDATABASE: conn.database,
    PGSSLMODE: conn.sslmode, // pg_dump/psql honour this — "require" forces TLS for managed Postgres
  };
}

/** A safe-to-display identity (never the password). */
export function connLabel(conn: PgConn): string {
  return `${conn.user}@${conn.host}:${conn.port}/${conn.database} (schema ${conn.schema})`;
}

/** True when source and dest point at the same host:port/database — a copy onto itself, which we refuse. */
export function sameTarget(a: PgConn, b: PgConn): boolean {
  return a.host === b.host && a.port === b.port && a.database === b.database && a.schema === b.schema;
}
