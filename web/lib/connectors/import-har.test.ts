import { test } from "node:test";
import assert from "node:assert/strict";
import { importHar, templatizeOperation } from "./import-har";

const har = (entries: unknown[]) => JSON.stringify({ log: { version: "1.2", entries } });

const entry = (over: Record<string, unknown> = {}) => ({
  request: {
    method: "GET",
    url: "https://api.vendor.com/v1/users?email=jane@medipost.com",
    headers: [
      { name: "accept", value: "application/json" },
      { name: "authorization", value: "Bearer super-secret-token" },
      { name: "cookie", value: "session=abc" },
    ],
    ...(over.request as object ?? {}),
  },
  response: { status: 200, content: { mimeType: "application/json" }, ...(over.response as object ?? {}) },
});

test("proposes API operations and drops assets/analytics", () => {
  const r = importHar(har([
    entry(),
    { request: { method: "GET", url: "https://api.vendor.com/app.js" }, response: { status: 200, content: { mimeType: "application/javascript" } } },
    { request: { method: "GET", url: "https://www.google-analytics.com/collect?v=1" }, response: { status: 200 } },
    {
      request: {
        method: "POST",
        url: "https://api.vendor.com/v1/users",
        headers: [{ name: "content-type", value: "application/json" }, { name: "x-api-key", value: "k-123" }],
        postData: { mimeType: "application/json", text: '{"email":"jane@medipost.com","name":"Jane"}' },
      },
      response: { status: 201, content: { mimeType: "application/json" } },
    },
  ]));
  assert.equal(r.operations.length, 2);
  assert.deepEqual(r.hosts, ["api.vendor.com"]);
  assert.ok(r.skipped >= 2);
  const post = r.operations.find((o) => o.method === "POST")!;
  assert.deepEqual(post.body, { email: "jane@medipost.com", name: "Jane" });
});

test("strips auth headers and surfaces them for re-declaration", () => {
  const r = importHar(har([entry()]));
  const op = r.operations[0];
  assert.equal(op.headers.authorization, undefined);
  assert.equal(op.headers.cookie, undefined);
  assert.equal(op.headers.accept, "application/json");
  assert.ok(op.strippedAuthHeaders.includes("authorization"));
  assert.ok(op.strippedAuthHeaders.includes("cookie"));
});

test("dedupes identical method+path and disambiguates names", () => {
  const r = importHar(har([
    entry(),
    entry(), // exact dup — dropped
    { request: { method: "GET", url: "https://api.vendor.com/v1/users?email=bob@x.com" }, response: { status: 200, content: { mimeType: "application/json" } } },
  ]));
  assert.equal(r.operations.length, 2); // one dup dropped
  const names = r.operations.map((o) => o.suggestedName);
  assert.equal(new Set(names).size, names.length, "names must be unique");
});

test("rejects non-HAR input gracefully", () => {
  assert.equal(importHar("not json").operations.length, 0);
  assert.match(importHar("not json").note, /not valid JSON/);
  assert.match(importHar(JSON.stringify({ foo: 1 })).note, /no request entries/);
});

test("only https requests become operations", () => {
  const r = importHar(har([{ request: { method: "GET", url: "http://api.vendor.com/v1/users" }, response: { status: 200, content: { mimeType: "application/json" } } }]));
  assert.equal(r.operations.length, 0);
});

test("templatizeOperation rewrites captured samples into placeholders, longest first", () => {
  const r = importHar(har([{
    request: {
      method: "POST",
      url: "https://api.vendor.com/v1/users",
      headers: [{ name: "content-type", value: "application/json" }],
      postData: { mimeType: "application/json", text: '{"email":"jane@medipost.com","name":"jane"}' },
    },
    response: { status: 201, content: { mimeType: "application/json" } },
  }]));
  const op = templatizeOperation(r.operations[0], [
    { value: "jane@medipost.com", template: "user.email" },
    { value: "jane", template: "user.givenName" },
  ]);
  assert.deepEqual(op.body, { email: "{{user.email}}", name: "{{user.givenName}}" });
});
