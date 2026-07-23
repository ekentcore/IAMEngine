import { test } from "node:test";
import assert from "node:assert/strict";
import { fullCopyDumpArgs, copyAuditDetail } from "./copy";
import type { PgConn } from "./config";

const SRC: PgConn = { host: "192.168.0.11", port: 5432, user: "evanhkent", password: "SRC-SECRET", database: "automationUM", schema: "public", sslmode: "disable" };
const DEST: PgConn = { host: "core-psql-1.postgres.database.azure.com", port: 5432, user: "psql_admin", password: "DEST-SECRET", database: "automationUM", schema: "public", sslmode: "require" };

test("fullCopyDumpArgs is a whole-database clone (clean + if-exists), NOT the old per-table/data-only flags", () => {
  const args = fullCopyDumpArgs();
  assert.deepEqual(args, ["--clean", "--if-exists"]);
  // must not carry the per-table / data-only / disable-triggers flags that omitted types & needed superuser
  for (const bad of ["--data-only", "--schema-only", "--disable-triggers", "-t"]) {
    assert.equal(args.includes(bad), false, `full clone must not use ${bad}`);
  }
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
