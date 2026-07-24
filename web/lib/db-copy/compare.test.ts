import { test } from "node:test";
import assert from "node:assert/strict";
import { buildComparison } from "./copy";

test("buildComparison flags matches and mismatches per table (union of both sides)", () => {
  const source = new Map<string, number>([["Client", 187], ["Agent", 10], ["AuditLog", 9172], ["OnlySource", 3]]);
  const dest = new Map<string, number>([["Client", 187], ["Agent", 9], ["AuditLog", 9172], ["OnlyDest", 5]]);
  const { rows, allMatch, mismatches } = buildComparison(source, dest);

  const byName = Object.fromEntries(rows.map((r) => [r.table, r]));
  assert.deepEqual(byName.Client, { table: "Client", sourceRows: 187, destRows: 187, match: true });
  assert.deepEqual(byName.Agent, { table: "Agent", sourceRows: 10, destRows: 9, match: false });
  assert.deepEqual(byName.OnlySource, { table: "OnlySource", sourceRows: 3, destRows: null, match: false });
  assert.deepEqual(byName.OnlyDest, { table: "OnlyDest", sourceRows: null, destRows: 5, match: false });
  assert.equal(allMatch, false);
  assert.equal(mismatches, 3); // Agent, OnlySource, OnlyDest
});

test("buildComparison reports allMatch when every table lines up", () => {
  const m = new Map<string, number>([["A", 1], ["B", 2]]);
  const { allMatch, mismatches, rows } = buildComparison(m, new Map(m));
  assert.equal(allMatch, true);
  assert.equal(mismatches, 0);
  assert.equal(rows.length, 2);
});

test("buildComparison sorts rows by table name for stable display", () => {
  const { rows } = buildComparison(new Map([["Zebra", 1], ["Alpha", 1]]), new Map([["Zebra", 1], ["Alpha", 1]]));
  assert.deepEqual(rows.map((r) => r.table), ["Alpha", "Zebra"]);
});
