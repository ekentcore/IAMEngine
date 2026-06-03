import { test } from "node:test";
import assert from "node:assert/strict";
import { dominantEmailDomain, emailDomainOf } from "./email-domain";

test("emailDomainOf extracts a clean domain, or null for malformed input", () => {
  assert.equal(emailDomainOf("Jane.Doe@Acme.COM"), "acme.com");
  assert.equal(emailDomainOf("  a@b.co  "), "b.co");
  assert.equal(emailDomainOf("bob@mail.acme.com"), "mail.acme.com"); // subdomain kept (no PSL offline)
  assert.equal(emailDomainOf("noatsign"), null);
  assert.equal(emailDomainOf("x@"), null); // empty domain
  assert.equal(emailDomainOf("@y.com"), null); // empty local part
  assert.equal(emailDomainOf("a@b@c.com"), null); // two @
  assert.equal(emailDomainOf("a@acme..com"), null); // double dot
  assert.equal(emailDomainOf("a@acme"), null); // no TLD
  assert.equal(emailDomainOf("a@-acme.com"), null); // leading hyphen label
  assert.equal(emailDomainOf(""), null);
  assert.equal(emailDomainOf(null), null);
});

test("dominantEmailDomain denylists the managing MSP's domain so it can't win a small client", () => {
  // 3 MSP engineers + 1 employee — without the MSP denylist the MSP domain would win 3/4.
  const r = dominantEmailDomain(["a@coretelligent.com", "b@core.tech", "c@zirkeltech.com", "jane@tinyco.io"]);
  assert.equal(r.counted, 1); // only the real employee survives
  assert.equal(r.domain, null); // and one contact is below the floor → abstain
});

// MarketScience's real customer_contact distribution (verified live): 36 marketscience.co,
// 2 zirkeltech.com (their MSP), 1 rippling.com (HR integration), 1 marketscience.com.
const MARKETSCIENCE = [
  ...Array(36).fill("user@marketscience.co"),
  "a@zirkeltech.com",
  "b@zirkeltech.com",
  "hr@rippling.com",
  "old@marketscience.com",
];

test("dominantEmailDomain picks the modal domain from a real fleet distribution", () => {
  const r = dominantEmailDomain(MARKETSCIENCE);
  assert.equal(r.domain, "marketscience.co");
  assert.ok(r.share > 0.9, `share ${r.share}`);
});

test("dominantEmailDomain drops denylisted integration domains before counting", () => {
  // rippling.com is denylisted, so 3 of them don't win — and only 1 real contact remains, which
  // is below the contact floor, so we abstain rather than crown acme on a sample of one.
  const r = dominantEmailDomain(["a@rippling.com", "a@rippling.com", "a@rippling.com", "real@acme.com"]);
  assert.equal(r.counted, 1); // the 3 rippling addresses were excluded
  assert.equal(r.domain, null);
});

test("dominantEmailDomain returns acme once enough non-denylisted contacts agree", () => {
  const r = dominantEmailDomain(["x@rippling.com", "a@acme.com", "b@acme.com", "c@acme.com"]);
  assert.equal(r.domain, "acme.com");
});

test("dominantEmailDomain abstains below the contact-count floor", () => {
  // two unanimous contacts is not enough confidence
  const r = dominantEmailDomain(["a@acme.com", "b@acme.com"]);
  assert.equal(r.domain, null);
  assert.equal(r.counted, 2);
});

test("dominantEmailDomain abstains without a clear majority", () => {
  const r = dominantEmailDomain(["a@x.com", "b@x.com", "c@y.com", "d@y.com", "e@z.com"]);
  assert.equal(r.domain, null); // top share 2/5 = 0.4 < 0.6
});

test("dominantEmailDomain ignores blanks/malformed and returns null on an empty set", () => {
  assert.equal(dominantEmailDomain([]).domain, null);
  assert.equal(dominantEmailDomain(["", null, undefined, "nope", "x@"]).domain, null);
  assert.equal(dominantEmailDomain([]).counted, 0);
});

test("dominantEmailDomain honors custom thresholds", () => {
  // lower the floor to 2 and a 2-contact unanimous set now qualifies
  const r = dominantEmailDomain(["a@acme.com", "b@acme.com"], { minContacts: 2 });
  assert.equal(r.domain, "acme.com");
});
