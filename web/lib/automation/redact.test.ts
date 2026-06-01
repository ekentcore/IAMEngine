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
