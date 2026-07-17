import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword, generatePassword, generateInitialPassword, validateManualPassword } from "./password";

test("hash then verify round-trips; wrong password fails", () => {
  const h = hashPassword("correct horse battery staple");
  assert.ok(h.startsWith("scrypt$"));
  assert.ok(verifyPassword("correct horse battery staple", h));
  assert.ok(!verifyPassword("wrong", h));
});

test("two hashes of the same password differ (random salt)", () => {
  assert.notEqual(hashPassword("same"), hashPassword("same"));
});

test("verify is safe against null / malformed stored values", () => {
  assert.ok(!verifyPassword("x", null));
  assert.ok(!verifyPassword("x", ""));
  assert.ok(!verifyPassword("x", "bcrypt$nope"));
  assert.ok(!verifyPassword("x", "scrypt$onlyonepart"));
});

test("generatePassword returns a non-trivial string", () => {
  assert.ok(generatePassword().length >= 16);
  assert.notEqual(generatePassword(), generatePassword());
});

test("generateInitialPassword satisfies M365 complexity (upper+lower+digit+symbol), 16 chars, no ambiguous", () => {
  for (let i = 0; i < 200; i++) {
    const p = generateInitialPassword();
    assert.equal(p.length, 16);
    assert.match(p, /[A-Z]/); assert.match(p, /[a-z]/); assert.match(p, /[0-9]/); assert.match(p, /[!@#$%^&*\-_+=]/);
    assert.doesNotMatch(p, /[0O1lI]/); // ambiguous chars excluded
  }
});

test("validateManualPassword accepts a compliant password and a passphrase with mixed categories", () => {
  assert.equal(validateManualPassword("Str0ng!pass"), null);
  assert.equal(validateManualPassword("Correct-Horse-Battery-Staple-7"), null); // FR #17 passphrase
  assert.equal(validateManualPassword("Abcd1234"), null); // exactly 8, 3 categories
});

test("validateManualPassword rejects empty, short, over-long, low-complexity, and edge whitespace", () => {
  assert.match(validateManualPassword("") ?? "", /Enter a password/);
  assert.match(validateManualPassword(undefined) ?? "", /Enter a password/);
  assert.match(validateManualPassword("Ab1!") ?? "", /at least 8/);
  assert.match(validateManualPassword("correcthorsebatterystaple") ?? "", /3 of/); // all lowercase = 1 category
  assert.match(validateManualPassword(" Str0ng!pass") ?? "", /leading\/trailing/);
  assert.match(validateManualPassword("Str0ng!pass ") ?? "", /leading\/trailing/);
  assert.match(validateManualPassword("A1!" + "a".repeat(300)) ?? "", /256 characters or fewer/);
});

test("validateManualPassword allows internal spaces in a passphrase", () => {
  assert.equal(validateManualPassword("Correct Horse Battery 7"), null);
});
