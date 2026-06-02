import { test } from "node:test";
import assert from "node:assert/strict";
import { postWorkNote, writeBackEnabled } from "./worknote";
import type { SnConfig } from "./types";

const config: SnConfig = { instanceUrl: "https://example.service-now.com", username: "u", password: "p" };

function fakeFetch(handlers: { match: (url: string, init?: RequestInit) => boolean; result: unknown; status?: number }[]): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const h = handlers.find((x) => x.match(String(url), init));
    if (!h) throw new Error(`unexpected fetch ${url}`);
    return {
      ok: (h.status ?? 200) < 400,
      status: h.status ?? 200,
      statusText: "OK",
      json: async () => ({ result: h.result }),
      text: async () => JSON.stringify(h.result),
    } as Response;
  }) as unknown as typeof fetch;
}

test("postWorkNote is a no-op when write-back is disabled", async () => {
  delete process.env.SN_WRITE_ENABLED;
  assert.equal(writeBackEnabled(), false);
  const r = await postWorkNote(config, "UM0028740", "hello", fakeFetch([]));
  assert.deepEqual(r, { ok: false, error: "ServiceNow write-back is disabled (SN_WRITE_ENABLED is not set)" });
});

test("postWorkNote resolves the sys_id then PATCHes work_notes when enabled", async () => {
  process.env.SN_WRITE_ENABLED = "true";
  // a container object avoids TS narrowing a closure-written `let` to `never`
  const cap: { patched?: { url: string; body: string } } = {};
  const fetcher = fakeFetch([
    { match: (url, init) => url.includes("sysparm_query=number%3DUM0028740") || (url.includes("number=") && (init?.method ?? "GET") === "GET"), result: [{ sys_id: "abc123" }] },
    {
      match: (url, init) => init?.method === "PATCH",
      result: { sys_id: "abc123" },
    },
  ]);
  // capture the PATCH body
  const wrapped = (async (url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") cap.patched = { url: String(url), body: String(init?.body) };
    return (fetcher as unknown as (u: string, i?: RequestInit) => Promise<Response>)(url, init);
  }) as unknown as typeof fetch;

  const r = await postWorkNote(config, "UM0028740", "step summary", wrapped);
  assert.deepEqual(r, { ok: true, sysId: "abc123" });
  assert.ok(cap.patched);
  assert.match(cap.patched.url, /\/abc123$/);
  assert.match(cap.patched.body, /work_notes/);
  delete process.env.SN_WRITE_ENABLED;
});

test("postWorkNote returns ok:false when the ticket is missing", async () => {
  process.env.SN_WRITE_ENABLED = "true";
  const r = await postWorkNote(config, "UM9999999", "x", fakeFetch([{ match: () => true, result: [] }]));
  assert.deepEqual(r, { ok: false, error: "UM ticket UM9999999 not found" });
  delete process.env.SN_WRITE_ENABLED;
});
