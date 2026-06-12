import { test } from "node:test";
import assert from "node:assert/strict";
import { redact } from "./redact";

test("strips Delinea / secret-server vault URLs", () => {
  const t = redact("Password: https://coretelligent.secretservercloud.com/app/#/secrets/14990/general here");
  assert.doesNotMatch(t, /secretservercloud/);
  assert.match(t, /\[secret reference removed\]/);
});

test("masks explicit password values but keeps the label", () => {
  const t = redact("Password: Hunter2!");
  assert.doesNotMatch(t, /Hunter2/);
  assert.match(t, /Password:\s*\[redacted\]/i);
});

test("masks the local part of emails but keeps the domain (backbone signal)", () => {
  const t = redact("Email jane.doe@acorecapital.com for access");
  assert.doesNotMatch(t, /jane\.doe/);
  assert.match(t, /\[user\]@acorecapital\.com/);
});

test("preserves naming-convention TEMPLATES in emails (not real PII)", () => {
  // KB documents the username convention, not a real person — keep it readable for the runbook.
  assert.equal(redact("Username: FirstName.LastName@drakestar.com"), "Username: FirstName.LastName@drakestar.com");
  assert.equal(redact("conflict -> Firstname.middleinitial@drakestar.com"), "conflict -> Firstname.middleinitial@drakestar.com");
  assert.equal(redact("use [FirstName].[LastName]@acme.com"), "use [FirstName].[LastName]@acme.com");
  assert.equal(redact("pattern {first}.{last}@acme.com"), "pattern {first}.{last}@acme.com");
  // An already-redacted placeholder stays put (idempotent).
  assert.equal(redact("[user]@acme.com"), "[user]@acme.com");
});

test("still masks a REAL person's email even alongside templates", () => {
  const t = redact("e.g. felix.kessler@drakestar.com (pattern FirstName.LastName@drakestar.com)");
  assert.doesNotMatch(t, /felix\.kessler/);
  assert.match(t, /\[user\]@drakestar\.com/);
  assert.match(t, /FirstName\.LastName@drakestar\.com/); // template kept
});

test("masks phone numbers and SSNs", () => {
  assert.match(redact("call 415-555-0199"), /\[phone\]/);
  assert.match(redact("SSN 123-45-6789"), /\[ssn\]/);
});

test("leaves ordinary runbook text untouched", () => {
  const t = "Add the user to the AAD-KnowBe4 and VPN_Users groups.";
  assert.equal(redact(t), t);
});

test("handles empty / undefined input", () => {
  assert.equal(redact(""), "");
  assert.equal(redact(undefined as unknown as string), undefined);
});
