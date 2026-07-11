import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSecret, resolveSecretFields, delineaConfigured, createSecret, shapeStubItems, checkFolderRead, checkFolderWrite, parseDelineaExpiry, type DelineaConfig, type Fetcher, type FetchResponse } from "./delinea";

const cfg: DelineaConfig = { baseUrl: "https://ctg.secretservercloud.com", username: "svc", password: "pw" };

// A fetcher that routes by URL: the oauth token endpoint, then the secret GET.
function fakeFetcher(secretResponse: { status: number; body?: unknown }): Fetcher {
  return async (url) => {
    if (url.includes("/oauth2/token")) {
      return { ok: true, status: 200, json: async () => ({ access_token: "tok-123" }) };
    }
    return {
      ok: secretResponse.status >= 200 && secretResponse.status < 300,
      status: secretResponse.status,
      json: async () => secretResponse.body ?? {},
    };
  };
}

test("delineaConfigured requires all three fields", () => {
  assert.equal(delineaConfigured(cfg), true);
  assert.equal(delineaConfigured({ ...cfg, password: "" }), false);
  assert.equal(delineaConfigured({ baseUrl: "", username: "", password: "" }), false);
});

test("checkSecret short-circuits on an unset / REPLACE_ME id without calling Delinea", async () => {
  let called = false;
  const spy: Fetcher = async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; };
  const res = await checkSecret(cfg, "REPLACE_ME", spy);
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /not set/i);
  assert.equal(called, false); // never hit the network for a placeholder
});

test("checkSecret reports not-configured when the app has no Delinea creds", async () => {
  const res = await checkSecret({ baseUrl: "", username: "", password: "" }, "48213", fakeFetcher({ status: 200 }));
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /not configured/i);
});

test("checkSecret returns ok + label (the secret name) on a 200, never the value", async () => {
  const res = await checkSecret(cfg, "48213", fakeFetcher({ status: 200, body: { id: 48213, name: "LogicSource 365 Admin", items: [{ fieldName: "Password", itemValue: "hunter2" }] } }));
  assert.equal(res.ok, true);
  assert.equal(res.label, "LogicSource 365 Admin");
  // the response is in scope here only to assert the value never leaks into the result shape
  assert.equal((res as Record<string, unknown>).items, undefined);
  assert.equal(JSON.stringify(res).includes("hunter2"), false);
});

test("checkSecret maps 404 / 403 / other to readable errors", async () => {
  assert.match((await checkSecret(cfg, "1", fakeFetcher({ status: 404 }))).error ?? "", /not found/i);
  assert.match((await checkSecret(cfg, "1", fakeFetcher({ status: 403 }))).error ?? "", /denied/i);
  assert.match((await checkSecret(cfg, "1", fakeFetcher({ status: 500 }))).error ?? "", /500/);
});

// --- resolveSecretFields: the push-down path. Unlike checkSecret, it DOES return the value
// (flattened fields) so the app can hand the credential to the runner over the job channel.

test("resolveSecretFields flattens items into fields and returns the label", async () => {
  const res = await resolveSecretFields(cfg, "56406", fakeFetcher({ status: 200, body: {
    id: 56406, name: "AD DC Admin", items: [
      { fieldName: "Username", itemValue: "svc-adjoin" },
      { fieldName: "Password", itemValue: "hunter2" },
      { fieldName: "Server", itemValue: "core-cce-dc01" },
    ],
  } }));
  assert.equal(res.ok, true);
  assert.equal(res.label, "AD DC Admin");
  assert.deepEqual(res.fields, { Username: "svc-adjoin", Password: "hunter2", Server: "core-cce-dc01" });
});

test("resolveSecretFields short-circuits on an unset id and on no config", async () => {
  let called = false;
  const spy: Fetcher = async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; };
  assert.match((await resolveSecretFields(cfg, "REPLACE_ME", spy)).error ?? "", /not set/i);
  assert.equal(called, false);
  assert.match((await resolveSecretFields({ baseUrl: "", username: "", password: "" }, "1", spy)).error ?? "", /not configured/i);
});

test("resolveSecretFields maps 404 / 403 / access-denied to readable errors", async () => {
  assert.match((await resolveSecretFields(cfg, "1", fakeFetcher({ status: 404 }))).error ?? "", /not found/i);
  assert.match((await resolveSecretFields(cfg, "1", fakeFetcher({ status: 403 }))).error ?? "", /denied/i);
  assert.match((await resolveSecretFields(cfg, "1", fakeFetcher({ status: 400, body: { errorCode: "API_AccessDenied" } }))).error ?? "", /denied/i);
});

// --- createSecret: the WRITE path. Fetches the template stub, drops values in by slug, POSTs it.

test("shapeStubItems fills itemValue by slug (and slugified field name), preserving other props; reports unmatched", () => {
  const stub = [
    { fieldId: 1, slug: "username", fieldName: "Username", itemValue: "", isFile: false },
    { fieldId: 2, slug: "password", fieldName: "Password", itemValue: "" },
    { fieldId: 3, fieldName: "Tenant Id", itemValue: "keep-me" }, // matched by slugified name
    { fieldId: 4, slug: "notes", fieldName: "Notes", itemValue: "untouched" }, // no value supplied
  ];
  const out = shapeStubItems(stub, { username: "svc", password: "pw", tenantid: "contoso.com" });
  assert.equal(out.items[0].itemValue, "svc");
  assert.equal(out.items[0].isFile, false); // preserved
  assert.equal(out.items[1].itemValue, "pw");
  assert.equal(out.items[2].itemValue, "contoso.com");
  assert.equal(out.items[3].itemValue, "untouched"); // left as-is when no value supplied
  assert.deepEqual(out.unmatched, []); // every supplied key landed
  // A key the template has no field for is reported, not silently dropped.
  assert.deepEqual(shapeStubItems(stub, { bogus: "x" }).unmatched, ["bogus"]);
});

// A fetcher for the write path: the name-search GET (dedup), the template-stub GET, and the create
// POST. `searchRecords` seeds an existing same-named secret so the idempotency path can be tested.
function writeFetcher(opts: { stubStatus?: number; postStatus?: number; postBody?: unknown; capture?: (body: unknown) => void; searchRecords?: { id: number | string; name: string }[]; postCalled?: () => void }): Fetcher {
  return async (url, init) => {
    if (url.includes("/oauth2/token")) return { ok: true, status: 200, json: async () => ({ access_token: "tok" }) };
    if (url.includes("/secrets/stub")) {
      const status = opts.stubStatus ?? 200;
      return { ok: status < 300, status, json: async () => ({ items: [{ fieldId: 1, slug: "username", itemValue: "" }, { fieldId: 2, slug: "password", itemValue: "" }] }) } as FetchResponse;
    }
    // GET /api/v1/secrets?filter.folderId=… — the dedup search.
    if (url.includes("filter.folderId")) {
      return { ok: true, status: 200, json: async () => ({ records: opts.searchRecords ?? [] }) } as FetchResponse;
    }
    // POST /api/v1/secrets
    opts.postCalled?.();
    if (init?.body) opts.capture?.(JSON.parse(init.body));
    const status = opts.postStatus ?? 200;
    return { ok: status < 300, status, json: async () => opts.postBody ?? { id: 90210 } } as FetchResponse;
  };
}

test("createSecret shapes the stub, POSTs it, and returns the new id (never echoes values)", async () => {
  let posted: Record<string, unknown> | undefined;
  const res = await createSecret(
    cfg,
    { name: "Acme — m365-admin", folderId: "142", templateId: 6001, fields: { username: "svc", password: "hunter2" } },
    "tok",
    writeFetcher({ capture: (b) => (posted = b as Record<string, unknown>) })
  );
  assert.equal(res.ok, true);
  assert.equal(res.id, "90210");
  // Body carries the folder/template + shaped items with our values.
  assert.equal(posted!.name, "Acme — m365-admin");
  assert.equal(posted!.folderId, 142); // numeric coercion
  assert.equal(posted!.secretTemplateId, 6001);
  const items = posted!.items as Array<{ slug: string; itemValue: string }>;
  assert.equal(items.find((i) => i.slug === "username")!.itemValue, "svc");
  assert.equal(items.find((i) => i.slug === "password")!.itemValue, "hunter2");
  // The result shape carries only the id — no values.
  assert.equal(JSON.stringify(res).includes("hunter2"), false);
});

test("createSecret maps auth + error statuses to readable errors", async () => {
  const denied = await createSecret(cfg, { name: "x", folderId: "1", templateId: 1, fields: {} }, "tok", writeFetcher({ stubStatus: 403 }));
  assert.equal(denied.ok, false);
  assert.match(denied.error ?? "", /denied/i);

  const postFail = await createSecret(cfg, { name: "x", folderId: "1", templateId: 1, fields: {} }, "tok", writeFetcher({ postStatus: 400, postBody: { message: "folder not found" } }));
  assert.equal(postFail.ok, false);
  assert.match(postFail.error ?? "", /400.*folder not found/i);

  const noId = await createSecret(cfg, { name: "x", folderId: "1", templateId: 1, fields: {} }, "tok", writeFetcher({ postBody: {} }));
  assert.equal(noId.ok, false);
  assert.match(noId.error ?? "", /no id/i);
});

test("createSecret is idempotent: an existing same-named secret in the folder is reused, not duplicated", async () => {
  let posted = false;
  const res = await createSecret(
    cfg,
    { name: "Acme — m365-admin", folderId: "142", templateId: 6001, fields: { username: "svc", password: "pw" } },
    "tok",
    writeFetcher({ searchRecords: [{ id: 555, name: "Acme — m365-admin" }], postCalled: () => (posted = true) })
  );
  assert.equal(res.ok, true);
  assert.equal(res.id, "555"); // the existing id, not a new one
  assert.equal(posted, false); // never POSTed a duplicate
});

test("createSecret refuses (no POST) when a supplied field has no matching template slug", async () => {
  let posted = false;
  const res = await createSecret(
    cfg,
    { name: "x", folderId: "1", templateId: 1, fields: { username: "svc", bogusfield: "v" } }, // stub has no 'bogusfield'
    "tok",
    writeFetcher({ postCalled: () => (posted = true) })
  );
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /no field matching.*bogusfield/i);
  assert.equal(posted, false); // did not create a blank/partial secret
});

// --- Folder access introspection ---------------------------------------------------------------

// Routes by URL: /folders/{id} (read), /folder-details/{id} (capability flags), /folder-permissions.
function folderFetcher(opts: {
  folderStatus?: number; folderBody?: unknown;
  detailsStatus?: number; detailsBody?: unknown;
  permsStatus?: number; permsBody?: unknown;
}): Fetcher {
  const mk = (status: number, body: unknown): FetchResponse => ({ ok: status >= 200 && status < 300, status, json: async () => body ?? {} });
  return async (url) => {
    if (url.includes("/oauth2/token")) return mk(200, { access_token: "tok-123" });
    if (url.includes("/folder-details/")) return mk(opts.detailsStatus ?? 404, opts.detailsBody);
    if (url.includes("/folder-permissions")) return mk(opts.permsStatus ?? 404, opts.permsBody);
    if (url.includes("/folders/")) return mk(opts.folderStatus ?? 200, opts.folderBody ?? { folderName: "Clients/Acme" });
    return mk(404, {});
  };
}

test("checkFolderRead: ok with folder name, denied, and missing", async () => {
  const okRes = await checkFolderRead(cfg, "142", folderFetcher({}));
  assert.deepEqual(okRes, { ok: true, name: "Clients/Acme" });

  const denied = await checkFolderRead(cfg, "142", folderFetcher({ folderStatus: 403 }));
  assert.equal(denied.ok, false);
  assert.match(denied.error ?? "", /denied/i);

  const missing = await checkFolderRead(cfg, "9", folderFetcher({ folderStatus: 404 }));
  assert.equal(missing.ok, false);
  assert.match(missing.error ?? "", /not found/i);
});

test("checkFolderWrite: capability flags decide ok vs fail", async () => {
  const can = await checkFolderWrite(cfg, "142", folderFetcher({ detailsStatus: 200, detailsBody: { actions: ["CreateSecret", "Edit"] } }));
  assert.equal(can.write, "ok");

  const cant = await checkFolderWrite(cfg, "142", folderFetcher({ detailsStatus: 200, detailsBody: { actions: ["View"] } }));
  assert.equal(cant.write, "fail");
  assert.match(cant.detail, /Add Secret/i);
});

test("checkFolderWrite: falls back to the permissions list, else degrades to unknown (never false-fails)", async () => {
  const viaPerms = await checkFolderWrite(cfg, "142", folderFetcher({
    permsStatus: 200,
    permsBody: { records: [{ userName: "svc", folderAccessRoleName: "Owner", secretAccessRoleName: "Owner" }] },
  }));
  assert.equal(viaPerms.write, "ok");

  const roleTooLow = await checkFolderWrite(cfg, "142", folderFetcher({
    permsStatus: 200,
    permsBody: { records: [{ userName: "svc", folderAccessRoleName: "View", secretAccessRoleName: "List" }] },
  }));
  assert.equal(roleTooLow.write, "fail");

  // Neither endpoint answers usefully -> unknown, not fail.
  const opaque = await checkFolderWrite(cfg, "142", folderFetcher({ detailsStatus: 500, permsStatus: 500 }));
  assert.equal(opaque.write, "unknown");

  const noFolder = await checkFolderWrite(cfg, "", folderFetcher({}));
  assert.equal(noFolder.write, "unknown");
});

test("checkFolderWrite: 403 on folder-details is a definite fail", async () => {
  const denied = await checkFolderWrite(cfg, "142", folderFetcher({ detailsStatus: 403 }));
  assert.equal(denied.write, "fail");
});

test("parseDelineaExpiry: explicit date, days-until, and absent", () => {
  const now = new Date("2026-07-11T00:00:00Z");
  assert.equal(parseDelineaExpiry({ expirationDate: "2026-09-01T00:00:00Z" }, now), "2026-09-01T00:00:00.000Z");
  assert.equal(parseDelineaExpiry({ secretExpirationDate: "2026-08-15" }, now)?.slice(0, 10), "2026-08-15");
  assert.equal(parseDelineaExpiry({ daysUntilExpiration: 10 }, now), "2026-07-21T00:00:00.000Z");
  assert.equal(parseDelineaExpiry({ name: "x" }, now), undefined);
  assert.equal(parseDelineaExpiry(null, now), undefined);
});
