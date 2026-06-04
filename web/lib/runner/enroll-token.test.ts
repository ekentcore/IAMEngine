import { test } from "node:test";
import assert from "node:assert/strict";
import { mintEnrollToken, verifyEnrollToken } from "./enroll-token";

const SECRET = "test-secret";
const NOW = 1_000_000_000_000;

test("round-trips scope + client", () => {
  const t = mintEnrollToken({ scope: "client_network", client: "coretelligent" }, SECRET, NOW);
  const c = verifyEnrollToken(t, SECRET, NOW);
  assert.equal(c?.scope, "client_network");
  assert.equal(c?.client, "coretelligent");
});

test("rejects a tampered payload (signature mismatch)", () => {
  const t = mintEnrollToken({ scope: "central", client: null }, SECRET, NOW);
  const [v, payload, sig] = t.split(".");
  // flip the payload to client_network/evil — signature no longer matches
  const forged = Buffer.from(JSON.stringify({ scope: "client_network", client: "evil", exp: NOW / 1000 + 3600 })).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assert.equal(verifyEnrollToken(`${v}.${forged}.${sig}`, SECRET, NOW), null);
});

test("rejects a token signed with a different secret", () => {
  const t = mintEnrollToken({ scope: "central", client: null }, SECRET, NOW);
  assert.equal(verifyEnrollToken(t, "other-secret", NOW), null);
});

test("rejects an expired token", () => {
  const t = mintEnrollToken({ scope: "central", client: null, ttlSeconds: 60 }, SECRET, NOW);
  assert.ok(verifyEnrollToken(t, SECRET, NOW + 59_000)); // still valid
  assert.equal(verifyEnrollToken(t, SECRET, NOW + 61_000), null); // expired
});

test("rejects malformed tokens", () => {
  for (const bad of ["", "garbage", "v1.only-two", "v2.a.b"]) assert.equal(verifyEnrollToken(bad, SECRET, NOW), null);
});
