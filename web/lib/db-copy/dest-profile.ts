// Destination connection profile for the db-copy form. We remember the NON-SECRET fields (so the form
// pre-fills next time) but NEVER the password — it is re-typed for every test/copy. Stored under a
// single app-setting key; the password lives only in the browser field and the request body.
import type { PrismaClient } from "@prisma/client";
import { getAppSetting, setAppSetting } from "@/lib/settings";
import { type PgConn, type SslMode, normalizeSslMode } from "./config";

export const DEST_PROFILE_KEY = "db_copy.destProfile";

export type DestProfile = { host: string; port: number; user: string; database: string; schema: string; sslmode: SslMode };

/** The connection identity WITHOUT the password — safe to persist and to send to the browser. */
export function pickProfile(conn: PgConn): DestProfile {
  return { host: conn.host, port: conn.port, user: conn.user, database: conn.database, schema: conn.schema, sslmode: conn.sslmode };
}

/** Re-attach a freshly-typed password to a stored profile to get a usable connection. */
export function connFromProfile(profile: DestProfile, password: string): PgConn {
  return { ...profile, password };
}

export type NormalizeResult =
  | { ok: true; profile: DestProfile }
  | { ok: false; missing: string[] };

/** Coerce/trim raw form input into a DestProfile, defaulting port 5432 + schema "public". */
export function normalizeProfileInput(input: {
  host?: unknown;
  port?: unknown;
  user?: unknown;
  database?: unknown;
  schema?: unknown;
  sslmode?: unknown;
}): NormalizeResult {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
  const host = str(input.host);
  const user = str(input.user);
  const database = str(input.database);
  const schema = str(input.schema) || "public";
  const port = Number(str(input.port)) || 5432;
  const sslmode = normalizeSslMode(input.sslmode);

  const missing: string[] = [];
  if (!host) missing.push("host");
  if (!user) missing.push("user");
  if (!database) missing.push("database");
  if (missing.length) return { ok: false, missing };
  return { ok: true, profile: { host, port, user, database, schema, sslmode } };
}

/** Load the saved destination profile (non-secret), or null if none saved yet. */
export async function getDestProfile(db: PrismaClient): Promise<DestProfile | null> {
  return getAppSetting<DestProfile>(db, DEST_PROFILE_KEY);
}

/** Persist the non-secret destination profile (never a password). */
export async function saveDestProfile(db: PrismaClient, profile: DestProfile): Promise<void> {
  await setAppSetting(db, DEST_PROFILE_KEY, profile);
}
