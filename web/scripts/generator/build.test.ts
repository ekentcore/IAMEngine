import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeDomain } from "./build";

test("normalizeDomain: extracts a real domain from a URL", () => {
  assert.equal(normalizeDomain("https://www.apollonwealth.com/contact"), "apollonwealth.com");
  assert.equal(normalizeDomain("Apollonwealth.com"), "apollonwealth.com");
});

test("normalizeDomain: rejects non-domains (no dot) — e.g. the SN hierarchy path", () => {
  // The KB's domain_raw is a path like "TOP/Willowridge Partners", NOT a web domain.
  // Splitting on '/' yields "top", which must NOT be treated as a domain (it has no dot)
  // or it poisons roster matching (every client collapses to the same bogus key).
  assert.equal(normalizeDomain("TOP/Willowridge Partners"), "");
  assert.equal(normalizeDomain("TOP/Community Veterinary Partners/Animal Hospital"), "");
  assert.equal(normalizeDomain("localhost"), "");
  assert.equal(normalizeDomain(""), "");
  assert.equal(normalizeDomain(null), "");
});
