import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchAccountContactEmails } from "./gateway";

const cfg = { instanceUrl: "https://x.service-now.com", username: "u", password: "p" };

test("fetchAccountContactEmails rejects a non-sys_id accountSysId without calling ServiceNow", async () => {
  let called = false;
  const spy = (async () => { called = true; return new Response("[]"); }) as unknown as typeof fetch;
  // injection attempt: a value carrying a query operator
  const r = await fetchAccountContactEmails(cfg, "abc^active=false^ORsomething", spy);
  assert.deepEqual(r, []);
  assert.equal(called, false);

  assert.deepEqual(await fetchAccountContactEmails(cfg, "", spy), []);
  assert.equal(called, false);
});

test("fetchAccountContactEmails accepts a valid 32-hex sys_id and extracts emails", async () => {
  const sysId = "ad69a894db8ad150b7b8ec62ca96197c";
  const fakeFetch = (async (url: string) => {
    assert.ok(url.includes("customer_contact"));
    // one page, then a short page ends pagination
    const offset = new URL(url).searchParams.get("sysparm_offset");
    const body = offset === "0"
      ? { result: [{ email: "a@acme.com" }, { email: "" }, { email: "b@acme.com" }] }
      : { result: [] };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const r = await fetchAccountContactEmails(cfg, sysId, fakeFetch);
  assert.deepEqual(r, ["a@acme.com", "b@acme.com"]); // blank dropped
});
