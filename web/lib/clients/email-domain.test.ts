import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveEmailDomain, normalizeDomainInput, type ResolveDeps } from "./email-domain";

function deps(emails: string[]): { deps: ResolveDeps; calls: { fetched: number; persisted: string[] } } {
  const calls = { fetched: 0, persisted: [] as string[] };
  return {
    calls,
    deps: {
      fetchContactEmails: async () => { calls.fetched++; return emails; },
      setEmailDomain: async (_id, domain) => { calls.persisted.push(domain); },
    },
  };
}

const baseClient = {
  id: "c1",
  primaryDomain: "market.science",
  emailDomain: null as string | null,
  emailDomainLocked: false,
  serviceNowSysId: "acct1",
};

test("normalizeDomainInput accepts a bare domain or a full address", () => {
  assert.equal(normalizeDomainInput("marketscience.co"), "marketscience.co");
  assert.equal(normalizeDomainInput("@marketscience.co"), "marketscience.co");
  assert.equal(normalizeDomainInput("jane@marketscience.co"), "marketscience.co");
  assert.equal(normalizeDomainInput("  Acme.COM "), "acme.com");
  assert.equal(normalizeDomainInput("nonsense"), null);
  assert.equal(normalizeDomainInput(""), null);
});

test("a per-case override wins and is not persisted (per-case only)", async () => {
  const { deps: d, calls } = deps(["x@marketscience.co"]);
  const r = await resolveEmailDomain(d, { client: baseClient, override: "jane@override.io" });
  assert.equal(r.domain, "override.io");
  assert.equal(r.source, "override");
  assert.equal(calls.fetched, 0); // didn't bother deriving
  assert.equal(calls.persisted.length, 0); // override is per-case, not saved
});

test("a locked curated domain is used without deriving", async () => {
  const { deps: d, calls } = deps(["a@marketscience.co", "b@marketscience.co", "c@marketscience.co"]);
  const r = await resolveEmailDomain(d, { client: { ...baseClient, emailDomain: "curated.com", emailDomainLocked: true } });
  assert.equal(r.domain, "curated.com");
  assert.equal(r.source, "locked");
  assert.equal(calls.fetched, 0);
});

test("contacts derive the dominant domain and persist it", async () => {
  const emails = [...Array(5).fill("u@marketscience.co"), "hr@rippling.com"];
  const { deps: d, calls } = deps(emails);
  const r = await resolveEmailDomain(d, { client: baseClient });
  assert.equal(r.domain, "marketscience.co");
  assert.equal(r.source, "contacts");
  assert.deepEqual(calls.persisted, ["marketscience.co"]); // cached for next time
});

test("does not re-persist when the derived domain already matches the cache", async () => {
  const emails = [...Array(5).fill("u@marketscience.co")];
  const { deps: d, calls } = deps(emails);
  const r = await resolveEmailDomain(d, { client: { ...baseClient, emailDomain: "marketscience.co" } });
  assert.equal(r.domain, "marketscience.co");
  assert.equal(calls.persisted.length, 0); // unchanged → no write
});

test("falls back to the cached emailDomain when contacts abstain", async () => {
  const { deps: d, calls } = deps(["a@x.com", "b@y.com"]); // no majority / too few
  const r = await resolveEmailDomain(d, { client: { ...baseClient, emailDomain: "prev.co" } });
  assert.equal(r.domain, "prev.co");
  assert.equal(r.source, "cached");
  assert.equal(calls.persisted.length, 0);
});

test("falls back to the website domain when contacts abstain and no cache", async () => {
  const { deps: d } = deps([]);
  const r = await resolveEmailDomain(d, { client: baseClient });
  assert.equal(r.domain, "market.science");
  assert.equal(r.source, "website");
});

test("a contact-fetch failure falls back without blocking (best-effort)", async () => {
  const failing: ResolveDeps = {
    fetchContactEmails: async () => { throw new Error("ServiceNow down"); },
    setEmailDomain: async () => {},
  };
  const r = await resolveEmailDomain(failing, { client: { ...baseClient, emailDomain: "cached.co" } });
  assert.equal(r.domain, "cached.co");
  assert.equal(r.source, "cached");
});

test("skips the contact fetch when the client has no ServiceNow link", async () => {
  const { deps: d, calls } = deps(["a@marketscience.co", "b@marketscience.co", "c@marketscience.co"]);
  const r = await resolveEmailDomain(d, { client: { ...baseClient, serviceNowSysId: null, emailDomain: "cached.co" } });
  assert.equal(calls.fetched, 0);
  assert.equal(r.domain, "cached.co");
  assert.equal(r.source, "cached");
});
