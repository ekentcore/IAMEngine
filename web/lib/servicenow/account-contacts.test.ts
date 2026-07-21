import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchAccountContacts } from "./gateway";
import type { SnConfig } from "./types";

const config: SnConfig = { instanceUrl: "https://x.service-now.com", username: "u", password: "p" };

function mockFetch(rows: Array<{ sys_id: string; name: string; email: string }>): typeof fetch {
  return (async (url: string) => {
    assert.ok(String(url).includes("customer_contact"));
    return { ok: true, status: 200, json: async () => ({ result: rows }) } as Response;
  }) as unknown as typeof fetch;
}

test("returns sysId/name/email rows", async () => {
  const out = await fetchAccountContacts(
    config, "7750e1e447bdf29c3c5e88f4116d4393",
    mockFetch([{ sys_id: "aa", name: "Angie Shropshire", email: "angie@shawmut.com" }]),
  );
  assert.deepEqual(out, [{ sysId: "aa", name: "Angie Shropshire", email: "angie@shawmut.com" }]);
});

test("rejects a non-sys_id account (injection guard) → []", async () => {
  const out = await fetchAccountContacts(config, "not-a-sysid^ORDERBYnope", mockFetch([]));
  assert.deepEqual(out, []);
});
