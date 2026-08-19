import { test } from "node:test";
import assert from "node:assert/strict";
import { adUpnFor } from "./ad-domain";

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
  const r = adUpnFor(payload, {
    backbone: "ad_standalone",
    identity: { usernamePatterns: ["{first}.{last}@{domain}", "{first}.{mi}@{domain}"], adDomain: "syee.local" },
  });
  assert.ok(r);
  assert.equal(r.upn, "suzanne.yee@syee.local");
  for (const f of r.fallbacks) assert.ok(f.endsWith("@syee.local"), `fallback ${f} is on the AD domain`);
});

test("the mail-domain payload is left untouched (pure)", () => {
  const p = { ...payload, userPrincipalName: "syee@olympuscosmetic.com" };
  const before = JSON.stringify(p);
  adUpnFor(p, { backbone: "ad_standalone", identity });
  assert.equal(JSON.stringify(p), before, "adUpnFor must not mutate its input");
});
