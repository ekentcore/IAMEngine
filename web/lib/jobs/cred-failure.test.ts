import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDelineaError, credFailure } from "./cred-failure";

test("classifyDelineaError buckets the resolver's messages into scriptable codes", () => {
  assert.equal(classifyDelineaError("Delinea 404 — secret not found"), "delinea_not_found");
  assert.equal(classifyDelineaError("secret 47165 does not exist"), "delinea_not_found");
  assert.equal(classifyDelineaError("Delinea 403 access denied"), "delinea_denied");
  assert.equal(classifyDelineaError("401 unauthorized"), "delinea_denied");
  assert.equal(classifyDelineaError("Delinea 500"), "delinea_unresolvable");
  assert.equal(classifyDelineaError("fetch failed: timeout"), "delinea_unresolvable");
});

test("credFailure carries the code, secret name, actionable fix, and timestamp — never a value", () => {
  const cf = credFailure("reference_missing", "m365-admin", "no Delinea reference wired");
  assert.equal(cf.code, "reference_missing");
  assert.equal(cf.secretName, "m365-admin");
  assert.match(cf.fix, /m365-admin/);
  assert.ok(!Number.isNaN(Date.parse(cf.at)));
  // every code has a fix line
  for (const code of ["not_needed", "not_authorized", "delinea_not_configured", "delinea_not_found", "delinea_denied", "delinea_unresolvable", "otp_unavailable"] as const) {
    assert.ok(credFailure(code, "x", "d").fix.length > 10, code);
  }
});

test("credFailure keeps the Delinea reference metadata when provided", () => {
  const cf = credFailure("delinea_denied", "spanning", "403", { externalId: "47165", source: "parent" });
  assert.equal(cf.externalId, "47165");
  assert.equal(cf.source, "parent");
});
