import { test } from "node:test";
import assert from "node:assert/strict";
import { generateAgentToken, tokenPrefix, hashToken, verifyToken, isAgentToken } from "./agent-token";

test("generateAgentToken produces an agt_ token whose prefix and hash round-trip", () => {
  const { token, prefix, hash } = generateAgentToken();
  assert.ok(token.startsWith("agt_"), "token is agt_-prefixed");
  assert.equal(prefix, token.slice(0, 12));
  assert.equal(prefix, tokenPrefix(token));
  assert.equal(hash, hashToken(token));
  assert.equal(verifyToken(token, hash), true);
});

test("verifyToken rejects a wrong token", () => {
  const a = generateAgentToken();
  const b = generateAgentToken();
  assert.equal(verifyToken(b.token, a.hash), false);
});

test("tokens are unique across calls", () => {
  const seen = new Set(Array.from({ length: 100 }, () => generateAgentToken().token));
  assert.equal(seen.size, 100);
});

test("isAgentToken only matches the agt_ scheme", () => {
  assert.equal(isAgentToken("agt_abc"), true);
  assert.equal(isAgentToken("shared-token-value"), false);
  assert.equal(isAgentToken(""), false);
});

test("verifyToken is length-safe (no throw on malformed hash)", () => {
  const { token } = generateAgentToken();
  assert.equal(verifyToken(token, "deadbeef"), false);
});
