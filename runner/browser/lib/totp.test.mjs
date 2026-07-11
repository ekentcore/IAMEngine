// node --test. RFC 6238 Appendix B test vectors (SHA-1) — the seed is the ASCII string
// "12345678901234567890", which is base32 "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ".
import { test } from "node:test";
import assert from "node:assert/strict";
import { totp, base32Decode } from "./totp.mjs";

const SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

test("base32Decode ignores spaces/case/padding", () => {
  assert.deepEqual(base32Decode("gezd gnbv"), base32Decode("GEZDGNBV"));
  assert.deepEqual(base32Decode("MFRA===="), base32Decode("mfra"));
});

test("RFC 6238 6-digit vectors", () => {
  const cases = [
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
    [20000000000, "353130"], // counter > 2^31 — exercises the modulo counter build
  ];
  for (const [secs, expected] of cases) {
    assert.equal(totp(SEED, { t: secs * 1000 }), expected, `T=${secs}`);
  }
});

test("throws on an empty/invalid seed rather than emitting a bogus code", () => {
  assert.throws(() => totp(""), /invalid base32/i);
  assert.throws(() => totp("!!!!"), /invalid base32/i);
});
