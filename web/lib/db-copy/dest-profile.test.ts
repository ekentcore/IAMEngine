import { test } from "node:test";
import assert from "node:assert/strict";
import { pickProfile, connFromProfile, normalizeProfileInput, DEST_PROFILE_KEY } from "./dest-profile";
import type { PgConn } from "./config";

const CONN: PgConn = { host: "h", port: 6432, user: "u", password: "SECRET", database: "d", schema: "app", sslmode: "require" };

test("pickProfile strips the password and keeps the connection identity (incl sslmode)", () => {
  const p = pickProfile(CONN);
  assert.deepEqual(p, { host: "h", port: 6432, user: "u", database: "d", schema: "app", sslmode: "require" });
  assert.equal(JSON.stringify(p).includes("SECRET"), false);
});

test("connFromProfile re-attaches the typed password and carries sslmode", () => {
  const p = pickProfile(CONN);
  const conn = connFromProfile(p, "typed-now");
  assert.deepEqual(conn, { host: "h", port: 6432, user: "u", password: "typed-now", database: "d", schema: "app", sslmode: "require" });
});

test("normalizeProfileInput coerces/defaults raw form input and reports missing required fields", () => {
  const ok = normalizeProfileInput({ host: " db ", port: "5432", user: "iam", database: "um", schema: "", sslmode: "require" });
  assert.deepEqual(ok, { ok: true, profile: { host: "db", port: 5432, user: "iam", database: "um", schema: "public", sslmode: "require" } });

  const bad = normalizeProfileInput({ host: "", port: "abc", user: "iam", database: "" });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.deepEqual(bad.missing.sort(), ["database", "host"]);
});

test("normalizeProfileInput defaults sslmode to disable when the form omits it", () => {
  const r = normalizeProfileInput({ host: "db", user: "iam", database: "um" });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.profile.sslmode, "disable");
});

test("DEST_PROFILE_KEY is the stable app-setting key", () => {
  assert.equal(DEST_PROFILE_KEY, "db_copy.destProfile");
});
