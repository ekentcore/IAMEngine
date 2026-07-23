import { test } from "node:test";
import assert from "node:assert/strict";
import { destDatabaseUrl, scrubMigrateOutput } from "./migrate";
import type { PgConn } from "./config";

const DEST: PgConn = {
  host: "core-psql-1.postgres.database.azure.com",
  port: 5432,
  user: "psql_admin",
  password: "p@ss:w/rd?#1",
  database: "automationUM",
  schema: "public",
  sslmode: "require",
};

test("destDatabaseUrl builds a valid URL with sslmode + schema and URL-encodes credentials", () => {
  const url = destDatabaseUrl(DEST);
  const u = new URL(url);
  assert.equal(u.protocol, "postgresql:");
  assert.equal(u.hostname, "core-psql-1.postgres.database.azure.com");
  assert.equal(u.port, "5432");
  assert.equal(u.pathname, "/automationUM");
  assert.equal(decodeURIComponent(u.username), "psql_admin");
  assert.equal(decodeURIComponent(u.password), "p@ss:w/rd?#1"); // special chars survive a round-trip
  assert.equal(u.searchParams.get("sslmode"), "require");
  assert.equal(u.searchParams.get("schema"), "public");
});

test("destDatabaseUrl omits sslmode when disabled", () => {
  const u = new URL(destDatabaseUrl({ ...DEST, sslmode: "disable" }));
  assert.equal(u.searchParams.get("sslmode"), null);
});

test("scrubMigrateOutput removes the destination password from captured output", () => {
  const raw = `Datasource "db": PostgreSQL at core-psql-1...\nusing url postgresql://psql_admin:p@ss:w/rd?#1@host/db\nApplied.`;
  const clean = scrubMigrateOutput(raw, DEST);
  assert.equal(clean.includes("p@ss:w/rd?#1"), false);
  assert.match(clean, /Applied\./);
});
