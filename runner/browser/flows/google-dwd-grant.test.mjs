// Pure-helper tests for the google-dwd-grant flow. These import ONLY the flow's pure exports (scope
// parsing / union reconciliation / result-line formatting) — never the default flow, which drives the
// real Admin console in a browser (validated live in Task 12, kept out of these unit tests).
//
//   node --test flows/google-dwd-grant.test.mjs        (from runner/browser)
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseScopeList, unionScopes, hasAllScopes, missingScopes, formatScopesForInput, formatDwdGrantedLine } from "./google-dwd-grant.mjs";

const A = "https://www.googleapis.com/auth/admin.directory.user";
const B = "https://www.googleapis.com/auth/admin.directory.group";
const C = "https://www.googleapis.com/auth/gmail.settings.basic";

test("parseScopeList: splits a comma-separated cell into trimmed scopes", () => {
  assert.deepEqual(parseScopeList(`${A}, ${B}`), [A, B]);
});

test("parseScopeList: splits on newlines/whitespace too (the table renders one per line)", () => {
  assert.deepEqual(parseScopeList(`${A}\n${B}\n  ${C}  `), [A, B, C]);
});

test("parseScopeList: dedupes and drops empties; a blank cell is an empty list", () => {
  assert.deepEqual(parseScopeList(`${A},,${A}, ${B}`), [A, B]);
  assert.deepEqual(parseScopeList(""), []);
  assert.deepEqual(parseScopeList(null), []);
});

test("unionScopes: existing first, then only the genuinely-new requested scopes, deduped", () => {
  assert.deepEqual(unionScopes([A, B], [B, C]), [A, B, C]);
  assert.deepEqual(unionScopes([], [A, A, B]), [A, B]);
  assert.deepEqual(unionScopes([A, B], []), [A, B]);
});

test("hasAllScopes: true only when every requested scope is present (order-independent)", () => {
  assert.equal(hasAllScopes([A, B, C], [C, A]), true);
  assert.equal(hasAllScopes([A, B, C], [A, B, C]), true);
  assert.equal(hasAllScopes([A], [A, B]), false);
  assert.equal(hasAllScopes([], [A]), false);
});

test("missingScopes: exactly the requested scopes not present, for the WARN line", () => {
  assert.deepEqual(missingScopes([A], [A, B, C]), [B, C]);
  assert.deepEqual(missingScopes([A, B, C], [A]), []);
});

test("formatScopesForInput: comma-joins for the Admin console's 'OAuth scopes' box", () => {
  assert.equal(formatScopesForInput([A, B]), `${A},${B}`);
  assert.equal(formatScopesForInput([A]), A);
});

test("formatDwdGrantedLine: prints the exact success contract line (DWD_GRANTED:<saClientId>)", () => {
  assert.equal(formatDwdGrantedLine("102938475610293847561"), "DWD_GRANTED:102938475610293847561");
});
