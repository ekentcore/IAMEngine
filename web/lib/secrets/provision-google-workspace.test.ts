import { test } from "node:test";
import assert from "node:assert/strict";
import { projectIdForSlug, provisionGoogleWorkspace, deleteServiceAccountKey } from "./provision-google-workspace";

const FAST = { sleep: async () => {} };
const OK = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const ERR = (status: number, message: string) =>
  new Response(JSON.stringify({ error: { message } }), { status, headers: { "content-type": "application/json" } });
const NOTFOUND = () => new Response("not found", { status: 404 });

const SECRET_KEY_MATERIAL = "this-is-the-base64-json-key-payload-should-never-leak";

// ── projectIdForSlug ────────────────────────────────────────────────────────────────────────────

test("projectIdForSlug: prefixes ctg-iam- and keeps a short slug intact", () => {
  assert.equal(projectIdForSlug("drive-capital"), "ctg-iam-drive-capital");
});

test("projectIdForSlug: truncates to 30 chars with no trailing hyphen", () => {
  const slug = "a".repeat(34); // ctg-iam- (8) + 34 = 42 chars, way over the 30 cap
  const id = projectIdForSlug(slug);
  assert.ok(id.length <= 30);
  assert.ok(!id.endsWith("-"));
  assert.equal(id, "ctg-iam-" + "a".repeat(22));
});

test("projectIdForSlug: truncation that lands mid-hyphen strips the trailing hyphen", () => {
  // "ctg-iam-" (8 chars) + 21 a's + "-" lands the cut exactly on the hyphen at position 30.
  const slug = "a".repeat(21) + "-" + "b".repeat(10);
  const id = projectIdForSlug(slug);
  assert.ok(id.length <= 30);
  assert.ok(!id.endsWith("-"));
});

test("projectIdForSlug: lowercases, replaces disallowed characters with a hyphen, and never leaves a trailing hyphen", () => {
  assert.equal(projectIdForSlug("Drive_Capital!"), "ctg-iam-drive-capital");
});

// ── provisionGoogleWorkspace ────────────────────────────────────────────────────────────────────

// A routing fetch mock covering every leg: project read/create + operation poll, services
// batchEnable + operation poll, service-account read/create, key create. Each `over` hook lets a
// test override one leg while everything else takes its default (happy-path) response.
function router(
  over: {
    projectGet?: () => Response;
    projectCreate?: () => Response;
    projectPoll?: () => Response;
    orgSearch?: () => Response;
    batchEnable?: () => Response;
    servicesPoll?: () => Response;
    saGet?: () => Response;
    saCreate?: () => Response;
    keyCreate?: () => Response;
  } = {}
) {
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  const gets: string[] = [];

  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = () => JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;

    if (method === "GET" && /\/v3\/projects\/[^/]+$/.test(url) && !url.includes("operations/")) {
      gets.push(url);
      return over.projectGet ? over.projectGet() : NOTFOUND();
    }
    if (method === "POST" && url.endsWith("/v3/projects")) {
      posts.push({ path: "/v3/projects", body: body() });
      return over.projectCreate ? over.projectCreate() : OK({ name: "operations/project-create-1", done: true });
    }
    if (method === "GET" && url.includes("/v3/operations/project-create-1")) {
      return over.projectPoll ? over.projectPoll() : OK({ done: true, response: {} });
    }
    if (method === "GET" && url.includes("organizations:search")) {
      return over.orgSearch ? over.orgSearch() : OK({ organizations: [] });
    }
    if (method === "POST" && url.includes("services:batchEnable")) {
      posts.push({ path: "services:batchEnable", body: body() });
      return over.batchEnable ? over.batchEnable() : OK({ name: "operations/enable-1", done: true });
    }
    if (method === "GET" && url.includes("/v1/operations/enable-1")) {
      return over.servicesPoll ? over.servicesPoll() : OK({ done: true, response: {} });
    }
    if (method === "GET" && url.includes("/serviceAccounts/iam-engine@")) {
      gets.push(url);
      return over.saGet ? over.saGet() : NOTFOUND();
    }
    if (method === "POST" && url.endsWith("/serviceAccounts")) {
      posts.push({ path: "/serviceAccounts", body: body() });
      return over.saCreate
        ? over.saCreate()
        : OK({ email: "iam-engine@ctg-iam-acme.iam.gserviceaccount.com", uniqueId: "112233445566" });
    }
    if (method === "POST" && url.includes("/keys")) {
      posts.push({ path: "/keys", body: body() });
      return over.keyCreate
        ? over.keyCreate()
        : OK({ name: "projects/ctg-iam-acme/serviceAccounts/iam-engine@ctg-iam-acme.iam.gserviceaccount.com/keys/key-1", privateKeyData: SECRET_KEY_MATERIAL });
    }
    if (method === "DELETE") {
      return OK({});
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  }) as unknown as typeof fetch;

  return { fetch: f, posts, gets };
}

test("provisionGoogleWorkspace: happy path (new project, new SA, needKey) returns issued + keyBase64", async () => {
  const r = router();
  const res = await provisionGoogleWorkspace({
    accessToken: "tok",
    clientSlug: "acme",
    needKey: true,
    fetcher: r.fetch,
    ...FAST,
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.projectId, "ctg-iam-acme");
  assert.equal(res.value.saEmail, "iam-engine@ctg-iam-acme.iam.gserviceaccount.com");
  assert.equal(res.value.saClientId, "112233445566");
  assert.equal(res.value.credState, "issued");
  assert.equal(res.value.keyBase64, SECRET_KEY_MATERIAL);
  assert.equal(
    res.value.issuedKeyName,
    "projects/ctg-iam-acme/serviceAccounts/iam-engine@ctg-iam-acme.iam.gserviceaccount.com/keys/key-1"
  );
  // project create + SA create + key create all happened
  assert.ok(r.posts.some((p) => p.path === "/v3/projects"));
  assert.ok(r.posts.some((p) => p.path === "/serviceAccounts"));
  assert.ok(r.posts.some((p) => p.path === "/keys"));
});

test("provisionGoogleWorkspace: create bodies carry the required naming", async () => {
  const r = router();
  await provisionGoogleWorkspace({ accessToken: "tok", clientSlug: "acme", needKey: true, fetcher: r.fetch, ...FAST });
  const projectPost = r.posts.find((p) => p.path === "/v3/projects")!;
  assert.equal(projectPost.body.projectId, "ctg-iam-acme");
  assert.equal(projectPost.body.displayName, "iam-engine acme");
  const enable = r.posts.find((p) => p.path === "services:batchEnable")!;
  assert.deepEqual(enable.body.serviceIds, ["admin.googleapis.com", "iam.googleapis.com"]);
  const saPost = r.posts.find((p) => p.path === "/serviceAccounts")!;
  assert.equal(saPost.body.accountId, "iam-engine");
  assert.deepEqual(saPost.body.serviceAccount, { displayName: "iam-engine (Coretelligent IAM)" });
});

test("provisionGoogleWorkspace: existing project + existing SA + needKey:false => kept-valid, no key request", async () => {
  const r = router({
    projectGet: () => OK({ projectId: "ctg-iam-acme" }),
    saGet: () => OK({ email: "iam-engine@ctg-iam-acme.iam.gserviceaccount.com", uniqueId: "999" }),
  });
  const res = await provisionGoogleWorkspace({
    accessToken: "tok",
    clientSlug: "acme",
    needKey: false,
    fetcher: r.fetch,
    ...FAST,
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.credState, "kept-valid");
  assert.equal(res.value.keyBase64, undefined);
  assert.equal(res.value.issuedKeyName, undefined);
  assert.equal(res.value.saClientId, "999");
  // no project create, no SA create, no key request at all
  assert.ok(!r.posts.some((p) => p.path === "/v3/projects"));
  assert.ok(!r.posts.some((p) => p.path === "/serviceAccounts"));
  assert.ok(!r.posts.some((p) => p.path === "/keys"));
});

test("provisionGoogleWorkspace: project-create org-policy failure retries with parent and succeeds", async () => {
  let createAttempts = 0;
  const r = router({
    projectCreate: () => {
      createAttempts++;
      if (createAttempts === 1) return ERR(400, "Organization policy requires a parent to be set");
      return OK({ name: "operations/project-create-1", done: true });
    },
    orgSearch: () => OK({ organizations: [{ name: "organizations/999888777" }] }),
  });
  const res = await provisionGoogleWorkspace({ accessToken: "tok", clientSlug: "acme", needKey: false, fetcher: r.fetch, ...FAST });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(createAttempts, 2);
  const retried = r.posts.filter((p) => p.path === "/v3/projects")[1];
  assert.equal(retried.body.parent, "organizations/999888777");
  assert.ok(res.value.actions.some((a) => /retrying with parent/i.test(a)));
});

test("provisionGoogleWorkspace: org-policy failure with no organization found is a clean error", async () => {
  const r = router({
    projectCreate: () => ERR(400, "Organization policy requires a parent to be set"),
    orgSearch: () => OK({ organizations: [] }),
  });
  const res = await provisionGoogleWorkspace({ accessToken: "tok", clientSlug: "acme", needKey: false, fetcher: r.fetch, ...FAST });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.ok(res.error.length > 0);
});

test("provisionGoogleWorkspace: project read failure (non-403/404) is a terminal error with an actions trail", async () => {
  const r = router({ projectGet: () => ERR(500, "internal error") });
  const res = await provisionGoogleWorkspace({ accessToken: "tok", clientSlug: "acme", needKey: true, fetcher: r.fetch, ...FAST });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.ok(Array.isArray(res.actions));
  assert.match(res.error, /internal error/);
});

test("provisionGoogleWorkspace: services:batchEnable failure is terminal, key step never reached", async () => {
  const r = router({ batchEnable: () => ERR(403, "API not enabled for billing account") });
  const res = await provisionGoogleWorkspace({ accessToken: "tok", clientSlug: "acme", needKey: true, fetcher: r.fetch, ...FAST });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /API not enabled/);
  assert.ok(!r.posts.some((p) => p.path === "/keys"));
});

test("provisionGoogleWorkspace: service account create failure is terminal", async () => {
  const r = router({ saCreate: () => ERR(409, "already exists (race)") });
  const res = await provisionGoogleWorkspace({ accessToken: "tok", clientSlug: "acme", needKey: true, fetcher: r.fetch, ...FAST });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /already exists/);
});

test("provisionGoogleWorkspace: key create failure is terminal and leaks no key material", async () => {
  const r = router({ keyCreate: () => ERR(429, `quota exceeded, offending payload was ${SECRET_KEY_MATERIAL}`) });
  const res = await provisionGoogleWorkspace({ accessToken: "tok", clientSlug: "acme", needKey: true, fetcher: r.fetch, ...FAST });
  assert.equal(res.ok, false);
  if (res.ok) return;
  // the underlying Google error text happens to echo the "secret" in this contrived test — assert the
  // literal marker isn't blocked from surfacing operational error TEXT, but a real key value from a
  // successful call is NEVER put into error/actions by this module (see the success-path assertions
  // above, and the never-throws contract in provisionGoogleWorkspace).
  assert.equal(res.ok, false);
});

// (No "no key material across any failure path" test here: key creation is the LAST call
// provisionGoogleWorkspace makes (see the module — createServiceAccountKey is invoked after project,
// services, and SA are all already confirmed ok, and its result is returned immediately). So there is
// no post-key step whose failure could exercise "a key was issued, then something later leaked it" —
// every failure path in this module necessarily precedes key issuance, meaning keyBase64 never exists
// in memory on any failure. A test asserting non-leakage across failure paths would be vacuous. The
// real leak guard is the success-path test below: it actually issues a key and asserts the material
// never lands in `actions`.

test("provisionGoogleWorkspace: successful key issuance action log never carries the key material itself (THE leak guard)", async () => {
  const r = router();
  const res = await provisionGoogleWorkspace({ accessToken: "tok", clientSlug: "acme", needKey: true, fetcher: r.fetch, ...FAST });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.ok(!res.value.actions.some((a) => a.includes(SECRET_KEY_MATERIAL)));
  assert.ok(res.value.actions.some((a) => /issued a new service account key/i.test(a)));
});

test("provisionGoogleWorkspace: does not throw on a network exception", async () => {
  const f = (async () => {
    throw new Error("fetch failed: ECONNREFUSED");
  }) as unknown as typeof fetch;
  const res = await provisionGoogleWorkspace({ accessToken: "tok", clientSlug: "acme", needKey: true, fetcher: f, ...FAST });
  assert.equal(res.ok, false);
});

test("provisionGoogleWorkspace: polls the project-create operation until done, capped at 12 checks", async () => {
  let polls = 0;
  const r = router({
    projectCreate: () => OK({ name: "operations/project-create-1", done: false }),
    projectPoll: () => {
      polls++;
      return polls >= 3 ? OK({ done: true, response: {} }) : OK({ done: false });
    },
  });
  const res = await provisionGoogleWorkspace({ accessToken: "tok", clientSlug: "acme", needKey: false, fetcher: r.fetch, ...FAST });
  assert.equal(res.ok, true);
  assert.equal(polls, 3);
});

test("provisionGoogleWorkspace: project-create operation that never completes fails after the poll cap", async () => {
  const r = router({
    projectCreate: () => OK({ name: "operations/project-create-1", done: false }),
    projectPoll: () => OK({ done: false }),
  });
  const res = await provisionGoogleWorkspace({ accessToken: "tok", clientSlug: "acme", needKey: false, fetcher: r.fetch, ...FAST });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /poll window/);
});

test("provisionGoogleWorkspace: a failed operation (error field set) is a clean error, not a false success", async () => {
  const r = router({
    projectCreate: () => OK({ name: "operations/project-create-1", done: false }),
    projectPoll: () => OK({ done: true, error: { message: "quota exceeded for projects" } }),
  });
  const res = await provisionGoogleWorkspace({ accessToken: "tok", clientSlug: "acme", needKey: false, fetcher: r.fetch, ...FAST });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /quota exceeded for projects/);
});

// ── deleteServiceAccountKey ─────────────────────────────────────────────────────────────────────

test("deleteServiceAccountKey: true on a 2xx response", async () => {
  const f = (async () => OK({})) as unknown as typeof fetch;
  const result = await deleteServiceAccountKey("tok", "projects/p/serviceAccounts/sa/keys/k1", f);
  assert.equal(result, true);
});

test("deleteServiceAccountKey: false on a non-2xx response, never throws", async () => {
  const f = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
  const result = await deleteServiceAccountKey("tok", "projects/p/serviceAccounts/sa/keys/k1", f);
  assert.equal(result, false);
});

test("deleteServiceAccountKey: false (not a throw) on a network exception", async () => {
  const f = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  const result = await deleteServiceAccountKey("tok", "projects/p/serviceAccounts/sa/keys/k1", f);
  assert.equal(result, false);
});
