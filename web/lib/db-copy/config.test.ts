import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEnvFile, connFromEnv, sameTarget, connLabel } from "./config";

const ENV = `
# source
POSTGRES_HOST=db.local
POSTGRES_PORT=5432
POSTGRES_USER=iam
POSTGRES_PASSWORD="p@ss$word"
POSTGRES_DB=iam_engine
POSTGRES_SCHEMA=public
# destination (the "1" set)
POSTGRES_HOST1=copy.local
POSTGRES_USER1=iam2
POSTGRES_PASSWORD1=secret2
POSTGRES_DB1=iam_copy
`;

test("parseEnvFile keeps quoted values with special chars intact", () => {
  const env = parseEnvFile(ENV);
  assert.equal(env.POSTGRES_PASSWORD, "p@ss$word");
  assert.equal(env.POSTGRES_HOST, "db.local");
});

test("connFromEnv builds the SOURCE from POSTGRES_* (no suffix)", () => {
  const { conn, missing } = connFromEnv(parseEnvFile(ENV), "");
  assert.deepEqual(missing, []);
  assert.deepEqual(conn, { host: "db.local", port: 5432, user: "iam", password: "p@ss$word", database: "iam_engine", schema: "public" });
});

test("connFromEnv builds the DEST from POSTGRES_*1; PORT1/SCHEMA1 default", () => {
  const { conn, missing } = connFromEnv(parseEnvFile(ENV), "1");
  assert.deepEqual(missing, []);
  assert.equal(conn?.host, "copy.local");
  assert.equal(conn?.database, "iam_copy");
  assert.equal(conn?.port, 5432, "PORT1 absent → default 5432");
  assert.equal(conn?.schema, "public", "SCHEMA1 absent → default public");
});

test("connFromEnv reports exactly the missing required dest vars", () => {
  const env = parseEnvFile("POSTGRES_HOST1=only.host\n");
  const { conn, missing } = connFromEnv(env, "1");
  assert.equal(conn, null);
  assert.deepEqual(missing.sort(), ["POSTGRES_DB1", "POSTGRES_PASSWORD1", "POSTGRES_USER1"]);
});

test("sameTarget detects a copy-onto-itself", () => {
  const c = { host: "h", port: 5432, user: "u", password: "p", database: "d", schema: "public" };
  assert.equal(sameTarget(c, { ...c }), true);
  assert.equal(sameTarget(c, { ...c, database: "other" }), false);
});

test("connLabel never includes the password", () => {
  const label = connLabel({ host: "h", port: 5432, user: "u", password: "TOPSECRET", database: "d", schema: "public" });
  assert.equal(label.includes("TOPSECRET"), false);
});
