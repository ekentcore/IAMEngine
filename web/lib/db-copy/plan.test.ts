import { test } from "node:test";
import assert from "node:assert/strict";
import { quoteIdent, qualified, dumpTableArg, dumpTableArgs, truncateStatement, classifyTables } from "./plan";

test("quoteIdent escapes embedded double-quotes", () => {
  assert.equal(quoteIdent("Client"), '"Client"');
  assert.equal(quoteIdent('we"ird'), '"we""ird"');
});

test("dumpTableArg quotes the table so pg_dump matches PascalCase literally", () => {
  assert.equal(dumpTableArg("public", "AuditLog"), 'public."AuditLog"');
});

test("dumpTableArgs alternates -t <arg> for each table", () => {
  assert.deepEqual(dumpTableArgs("public", ["Client", "Job"]), ["-t", 'public."Client"', "-t", 'public."Job"']);
});

test("truncateStatement builds RESTART IDENTITY CASCADE over the qualified list", () => {
  assert.equal(
    truncateStatement("public", ["Client", "Job"]),
    'TRUNCATE "public"."Client", "public"."Job" RESTART IDENTITY CASCADE;',
  );
});

test("truncateStatement is null when there is nothing to truncate", () => {
  assert.equal(truncateStatement("public", []), null);
});

test("classifyTables splits source tables into missing vs existing against the dest set", () => {
  const plan = classifyTables(["Client", "Job", "Agent"], new Set(["Client", "Agent"]));
  assert.deepEqual(plan.all, ["Client", "Job", "Agent"]);
  assert.deepEqual(plan.missing, ["Job"]);
  assert.deepEqual(plan.existing, ["Client", "Agent"]);
});
