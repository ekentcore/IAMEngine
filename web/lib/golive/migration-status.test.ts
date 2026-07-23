import { test } from "node:test";
import assert from "node:assert/strict";
import { diffMigrations, type AppliedMigrationRow } from "./migration-status";

const applied = (name: string): AppliedMigrationRow => ({ migration_name: name, finished_at: new Date(), rolled_back_at: null });

test("diffMigrations: every expected migration applied → pass", () => {
  const r = diffMigrations(["a", "b"], [applied("a"), applied("b"), applied("c_older_extra")]);
  assert.equal(r.verdict, "pass");
  assert.equal(r.expected, 2);
  assert.equal(r.applied, 2);
  assert.deepEqual(r.missing, []);
});

test("diffMigrations: an expected migration absent from the DB → fail (schema behind code)", () => {
  const r = diffMigrations(["a", "b", "c"], [applied("a"), applied("b")]);
  assert.equal(r.verdict, "fail");
  assert.deepEqual(r.missing, ["c"]);
});

test("diffMigrations: an expected migration present but unfinished → fail", () => {
  const r = diffMigrations(["a"], [{ migration_name: "a", finished_at: null, rolled_back_at: null }]);
  assert.equal(r.verdict, "fail");
  assert.deepEqual(r.missing, ["a"]);
});

test("diffMigrations: an applied row rolled back → fail (counted as rolledBack, not missing)", () => {
  const r = diffMigrations(["a"], [{ migration_name: "a", finished_at: new Date(), rolled_back_at: new Date() }]);
  assert.equal(r.verdict, "fail");
  assert.deepEqual(r.rolledBack, ["a"]);
  assert.deepEqual(r.missing, []);
});

test("diffMigrations: empty expected set → warn, never a false pass", () => {
  const r = diffMigrations([], [applied("a")]);
  assert.equal(r.verdict, "warn");
  assert.equal(r.expected, 0);
});
