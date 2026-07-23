import { test } from "node:test";
import assert from "node:assert/strict";
import { dataCopyDumpArgs, copyAuditDetail } from "./copy";
import type { PgConn } from "./config";

const SRC: PgConn = { host: "192.168.0.11", port: 5432, user: "evanhkent", password: "SRC-SECRET", database: "automationUM", schema: "public", sslmode: "disable" };
const DEST: PgConn = { host: "core-psql-1.postgres.database.azure.com", port: 5432, user: "psql_admin", password: "DEST-SECRET", database: "automationUM", schema: "public", sslmode: "require" };

test("dataCopyDumpArgs is a DATA-only load into an existing schema — no schema DDL, no superuser-only flags", () => {
  const args = dataCopyDumpArgs("public", ["Client", "Agent"]);
  assert.equal(args[0], "--data-only");
  // no schema-ownership statements (--clean/schema DDL) and no --disable-triggers (needs superuser on Azure)
  for (const bad of ["--disable-triggers", "--clean", "--if-exists", "--schema-only"]) {
    assert.equal(args.includes(bad), false, `data-only load must not use ${bad}`);
  }
  // restricted to the given tables via -t
  assert.deepEqual(args, ["--data-only", "-t", 'public."Client"', "-t", 'public."Agent"']);
});

test("copyAuditDetail records where it went (source→dest identities) and who — never a password", () => {
  const d = copyAuditDetail(SRC, DEST, { ok: true, tables: 35, durationMs: 4200 });
  assert.equal(d.source, "192.168.0.11:5432/automationUM");
  assert.equal(d.dest, "core-psql-1.postgres.database.azure.com:5432/automationUM");
  assert.equal(d.ok, true);
  assert.equal(d.tables, 35);
  assert.equal(d.durationMs, 4200);
  const json = JSON.stringify(d);
  assert.equal(json.includes("SRC-SECRET"), false);
  assert.equal(json.includes("DEST-SECRET"), false);
});

test("copyAuditDetail scrubs the passwords out of a failure reason", () => {
  const d = copyAuditDetail(SRC, DEST, { ok: false, error: `psql failed for DEST-SECRET and SRC-SECRET at postgresql://psql_admin:DEST-SECRET@host/db` });
  const json = JSON.stringify(d);
  assert.equal(d.ok, false);
  assert.equal(json.includes("DEST-SECRET"), false, "dest password scrubbed from error");
  assert.equal(json.includes("SRC-SECRET"), false, "source password scrubbed from error");
  assert.match(String(d.error), /psql failed/, "keeps the human-readable reason");
});
