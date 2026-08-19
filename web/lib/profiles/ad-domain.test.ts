import { test } from "node:test";
import assert from "node:assert/strict";
import { adUpnFor, mergeAdDomain } from "./ad-domain";

const payload = { firstName: "Suzanne", lastName: "Yee" };
const identity = { usernamePatterns: ["{firstinitial}{last}@{domain}"], adDomain: "syee.local" };

test("rewrites the UPN to the AD domain for an ad-standalone client", () => {
  const r = adUpnFor({ ...payload, userPrincipalName: "syee@olympuscosmetic.com" },
    { backbone: "ad_standalone", identity });
  assert.ok(r);
  assert.equal(r.upn, "syee@syee.local");
});

test("returns null for an ad_synced client even when adDomain is set", () => {
  // On a synced client the AD UPN and the cloud UPN are the SAME by definition — rewriting one
  // would break the hard-match the sync depends on.
  assert.equal(adUpnFor(payload, { backbone: "ad_synced", identity }), null);
});

test("returns null for entra and google clients", () => {
  for (const backbone of ["entra", "google", null, undefined]) {
    assert.equal(adUpnFor(payload, { backbone: backbone as string | null, identity }), null, `backbone ${backbone}`);
  }
});

test("returns null for a standalone client with no adDomain configured", () => {
  assert.equal(adUpnFor(payload, { backbone: "ad_standalone", identity: { usernamePatterns: ["{first}.{last}@{domain}"] } }), null);
});

test("returns null when adDomain is blank or whitespace", () => {
  for (const adDomain of ["", "   "]) {
    assert.equal(adUpnFor(payload, { backbone: "ad_standalone", identity: { usernamePatterns: ["{first}.{last}@{domain}"], adDomain } }), null);
  }
});

test("accepts the hyphenated schema spelling of the backbone", () => {
  // profiles/_schema.json writes "ad-standalone"; the Prisma enum is "ad_standalone".
  const r = adUpnFor(payload, { backbone: "ad-standalone", identity });
  assert.ok(r);
  assert.equal(r.upn, "syee@syee.local");
});

test("carries the conflict fallbacks onto the AD domain too", () => {
  // NOTE: `payload` alone has no `mi`, so deriveIdentity's pattern-usable check would drop the
  // second pattern entirely and `fallbacks` would come back [] — the loop below would then pass
  // vacuously even if fallback rewriting were broken. Give this payload a middle initial so a
  // fallback actually materialises, and assert the array is non-empty BEFORE looping.
  const r = adUpnFor({ ...payload, mi: "Q" }, {
    backbone: "ad_standalone",
    identity: { usernamePatterns: ["{first}.{last}@{domain}", "{first}.{mi}@{domain}"], adDomain: "syee.local" },
  });
  assert.ok(r);
  assert.equal(r.upn, "suzanne.yee@syee.local");
  assert.ok(r.fallbacks.length > 0, "expected at least one fallback to materialise");
  for (const f of r.fallbacks) assert.ok(f.endsWith("@syee.local"), `fallback ${f} is on the AD domain`);
});

test("the mail-domain payload is left untouched (pure)", () => {
  const p = { ...payload, userPrincipalName: "syee@olympuscosmetic.com" };
  const before = JSON.stringify(p);
  adUpnFor(p, { backbone: "ad_standalone", identity });
  assert.equal(JSON.stringify(p), before, "adUpnFor must not mutate its input");
});

test("mergeAdDomain merges adDomain into identity without disturbing other keys", () => {
  // adDomain lives inside the identity Json blob, so the merge must not replace identity wholesale
  // and lose usernamePatterns / password / whatever else is there.
  const before = { usernamePatterns: ["{firstinitial}{last}@{domain}"], password: { mode: "generated" } };
  const merged = mergeAdDomain(before, "syee.local");
  assert.deepEqual(merged.usernamePatterns, before.usernamePatterns);
  assert.deepEqual(merged.password, before.password);
  assert.equal(merged.adDomain, "syee.local");
});

test("mergeAdDomain does not mutate the identity object it was given", () => {
  const before = { usernamePatterns: ["x"] };
  const beforeJson = JSON.stringify(before);
  mergeAdDomain(before, "syee.local");
  assert.equal(JSON.stringify(before), beforeJson);
});

test("a blank adDomain clears the field rather than storing an empty string", () => {
  for (const blank of ["", "   "]) {
    const merged = mergeAdDomain({ usernamePatterns: ["x"], adDomain: "syee.local" }, blank);
    assert.equal(merged.adDomain, undefined);
    assert.deepEqual(merged.usernamePatterns, ["x"]);
  }
});

test("mergeAdDomain tolerates a missing/non-object identity", () => {
  assert.equal(mergeAdDomain(null, "syee.local").adDomain, "syee.local");
  assert.equal(mergeAdDomain(undefined, "syee.local").adDomain, "syee.local");
});

test("adDomain is rejected if it isn't a plausible DNS name", () => {
  for (const bad of ["not a domain", "syee.local/x", "http://syee.local"]) {
    assert.throws(() => mergeAdDomain({ usernamePatterns: ["x"] }, bad), /domain/i, bad);
  }
});

test("adDomain accepts a .local namespace (core2187's real case)", () => {
  assert.equal(mergeAdDomain({}, "syee.local").adDomain, "syee.local");
});
