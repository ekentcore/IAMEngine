import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCondition, parseCondition, serializeCondition, type ConditionModel } from "./condition-builder";
import { evalCondition } from "./conditions";

test("validateCondition: empty / whitespace is valid (always-true)", () => {
  assert.deepEqual(validateCondition(""), { ok: true });
  assert.deepEqual(validateCondition("   "), { ok: true });
});

test("validateCondition: accepts the real grammar", () => {
  assert.equal(validateCondition("country.short == IN").ok, true);
  assert.equal(validateCondition("country.short == US && employmentType == Full-Time").ok, true);
  assert.equal(validateCondition("title ~= ^Remote Support").ok, true);
  assert.equal(validateCondition("location.name in [CA, GA, TX]").ok, true);
  assert.equal(validateCondition("a == 1 && b == 2 || c == 3").ok, true);
});

test("validateCondition: rejects a term with no recognized operator", () => {
  const r = validateCondition("country.short IN");
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /country\.short IN/);
});

test("validateCondition: rejects a stray || (empty branch would match everyone)", () => {
  for (const expr of ["country.short == IN ||", "|| country.short == IN", "a == 1 || || b == 2"]) {
    const r = validateCondition(expr);
    assert.equal(r.ok, false, expr);
    assert.match((r as { error: string }).error, /empty condition|\|\|/);
  }
});

test("parseCondition: single term round-trips", () => {
  const m = parseCondition("country.short == IN");
  assert.deepEqual(m, [[{ var: "country.short", op: "==", value: "IN" }]]);
  assert.equal(serializeCondition(m as ConditionModel), "country.short == IN");
});

test("parseCondition: AND/OR groups and `in`", () => {
  const m = parseCondition("country.short == US && employmentType == Full-Time || role.name in [Sales, Ops]");
  assert.deepEqual(m, [
    [{ var: "country.short", op: "==", value: "US" }, { var: "employmentType", op: "==", value: "Full-Time" }],
    [{ var: "role.name", op: "in", value: "Sales, Ops" }],
  ]);
});

test("parseCondition: empty -> one empty group (an always-true rule the builder can fill)", () => {
  assert.deepEqual(parseCondition(""), [[]]);
});

test("parseCondition: returns null for an unparseable expression (UI falls back to raw)", () => {
  assert.equal(parseCondition("country.short IN"), null);
});

test("serialize then eval matches the hand-written string (builder output is grammar-correct)", () => {
  const model: ConditionModel = [[{ var: "country.short", op: "==", value: "IN" }]];
  const expr = serializeCondition(model);
  const ctx = { country: { short: "IN" } };
  assert.equal(evalCondition(expr, ctx), true);
  assert.equal(evalCondition(expr, { country: { short: "US" } }), false);
});

test("serialize `in` produces bracketed list the evaluator accepts", () => {
  const expr = serializeCondition([[{ var: "location.name", op: "in", value: "CA, GA" }]]);
  assert.equal(expr, "location.name in [CA, GA]");
  assert.equal(evalCondition(expr, { location: { name: "GA" } }), true);
  assert.equal(evalCondition(expr, { location: { name: "TX" } }), false);
});
