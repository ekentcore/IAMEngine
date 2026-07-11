// Unit tests for the fix-lane worker's pure helpers (scripts/claude-fix.mjs). The script guards
// its main() behind an argv check, so importing it here runs nothing — no worktrees, no Claude.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEnvFile, buildPrompt, moduleFromTitle } from "../../../scripts/claude-fix.mjs";

test("parseEnvFile: KEY=VALUE with quotes, comments, blanks, embedded =", () => {
  const env = parseEnvFile([
    "# comment",
    "",
    'DATABASE_URL="postgresql://u:p@host:5432/db?schema=public"',
    "PLAIN=value",
    "SINGLE='quoted'",
    "WITH_EQ=a=b=c",
    "  SPACED = padded ",
    "NOEQUALS",
    "=novalue",
  ].join("\n"));
  assert.equal(env.DATABASE_URL, "postgresql://u:p@host:5432/db?schema=public");
  assert.equal(env.PLAIN, "value");
  assert.equal(env.SINGLE, "quoted");
  assert.equal(env.WITH_EQ, "a=b=c");
  assert.equal(env.SPACED, "padded");
  assert.ok(!("NOEQUALS" in env));
  assert.ok(!("" in env));
});

test("moduleFromTitle: systemKey prefix before the colon, lowercased; fallback when none", () => {
  assert.equal(moduleFromTitle("m365: license assignment failed"), "m365");
  assert.equal(moduleFromTitle("google-workspace: user not found"), "google-workspace");
  assert.equal(moduleFromTitle("Active_Directory.v2: LDAP 53"), "active_directory.v2");
  assert.equal(moduleFromTitle("no module prefix here"), "fix-lane");
  assert.equal(moduleFromTitle(""), "fix-lane");
});

test("buildPrompt: carries the failure context and the guardrail instructions", () => {
  const p = buildPrompt({ title: "m365: seat exhausted", context: "m365 (UM0012345)\nno seats left" });
  assert.ok(p.includes("m365: seat exhausted"));
  assert.ok(p.includes("no seats left"));
  assert.ok(p.includes("npx tsc --noEmit"));
  assert.ok(p.includes("MINIMAL"));
  assert.ok(p.includes("one-paragraph diagnosis"));
  assert.ok(p.includes("never push, never merge"));
  assert.ok(p.includes("Commit"));
});
