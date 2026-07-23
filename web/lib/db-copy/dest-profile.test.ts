import { test } from "node:test";
import assert from "node:assert/strict";
import { pickProfile, connFromProfile, normalizeProfileInput, DEST_PROFILE_KEY } from "./dest-profile";
import type { PgConn } from "./config";

const CONN: PgConn = { host: "h", port: 6432, user: "u", password: "SECRET", database: "d", schema: "app" };

test("pickProfile strips the password and keeps the connection identity", () => {
  const p = pickProfile(CONN);
  assert.deepEqual(p, { host: "h", port: 6432, user: "u", database: "d", schema: "app" });
  assert.equal(JSON.stringify(p).includes("SECRET"), false);
});

test("connFromProfile re-attaches the typed password", () => {
  const p = pickProfile(CONN);
  const conn = connFromProfile(p, "typed-now");
  assert.deepEqual(conn, { host: "h", port: 6432, user: "u", password: "typed-now", database: "d", schema: "app" });
});

test("normalizeProfileInput coerces/defaults raw form input and reports missing required fields", () => {
  const ok = normalizeProfileInput({ host: " db ", port: "5432", user: "iam", database: "um", schema: "" });
  assert.deepEqual(ok, { ok: true, profile: { host: "db", port: 5432, user: "iam", database: "um", schema: "public" } });

  const bad = normalizeProfileInput({ host: "", port: "abc", user: "iam", database: "" });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.deepEqual(bad.missing.sort(), ["database", "host"]);
});

test("DEST_PROFILE_KEY is the stable app-setting key", () => {
  assert.equal(DEST_PROFILE_KEY, "db_copy.destProfile");
});
