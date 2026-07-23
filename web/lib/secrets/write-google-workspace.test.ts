import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import type { Fetcher, FetchResponse } from "./delinea";
import { writeGoogleWorkspaceCreds, googleLabeledValues, GOOGLE_SECRET_NAME, type WriteGoogleClientInput } from "./write-google-workspace";
import type { GoogleProvision } from "./provision-google-workspace";

const CLIENT: WriteGoogleClientInput = { id: "client1", slug: "acme", name: "Acme Corp", delineaFolderId: "142" };

// Default credState is "issued" — most tests exercise a freshly-minted key that must be vaulted.
// Tests exercising the "kept-valid" contract override it explicitly.
function provision(overrides: Partial<GoogleProvision> = {}): GoogleProvision {
  return {
    projectId: "ctg-iam-acme",
    saEmail: "iam-engine@ctg-iam-acme.iam.gserviceaccount.com",
    saClientId: "109876543210",
    credState: "issued",
    keyBase64: "ZmFrZWtleQ==",
    issuedKeyName: "projects/ctg-iam-acme/serviceAccounts/iam-engine@ctg-iam-acme.iam.gserviceaccount.com/keys/abc123",
    actions: [],
    ...overrides,
  };
}

const ENV_CONFIGURED = {
  DELINEA_BASE_URL: "https://ctg.secretservercloud.com",
  DELINEA_WRITE_USER: "svc-write",
  DELINEA_WRITE_PASSWORD: "pw",
  DELINEA_TEMPLATE_GOOGLE_ADMIN: "7002",
};
const ENV_NOT_CONFIGURED = { DELINEA_BASE_URL: "https://ctg.secretservercloud.com" };

// Routes: Delinea oauth2/token, findChildFolderByName's parentFolderId search (Identity Services),
// createSecret's own dedup search (filter.folderId), the template stub, the create POST, and the
// per-field PUT.
function fetcher(opts: {
  childFolderId?: number | string; // returned for a "filter.parentFolderId" search (Identity Services)
  searchRecords?: { id: number | string; name: string }[];
  createId?: number | string;
  capturedCreateFields?: (fields: Record<string, string>) => void;
  capturedCreateName?: (name: string) => void;
  capturedCreateFolderId?: (folderId: string) => void;
  capturedUpdates?: (calls: { slug: string; value: string }[]) => void;
  createCalled?: () => void;
  createFails?: boolean;
  updateFails?: boolean;
  capturedPutUrls?: (urls: string[]) => void;
} = {}): Fetcher {
  const putUrls: string[] = [];
  const puts: { slug: string; value: string }[] = [];
  return (async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    if (url.includes("/oauth2/token")) {
      return { ok: true, status: 200, json: async () => ({ access_token: "delinea-tok" }) } as FetchResponse;
    }
    if (url.includes("filter.parentFolderId")) {
      const records = opts.childFolderId != null ? [{ id: opts.childFolderId, folderName: "Identity Services" }] : [];
      return { ok: true, status: 200, json: async () => ({ records }) } as FetchResponse;
    }
    if (url.includes("filter.folderId")) {
      return { ok: true, status: 200, json: async () => ({ records: opts.searchRecords ?? [] }) } as FetchResponse;
    }
    if (url.includes("/secrets/stub")) {
      opts.createCalled?.();
      if (opts.createFails) {
        return { ok: false, status: 403, json: async () => ({ message: "no template access" }) } as FetchResponse;
      }
      const items = ["clientid", "clientsecret", "accountid", "apiurl"].map((slug, i) => ({ fieldId: i + 1, slug, itemValue: "" }));
      return { ok: true, status: 200, json: async () => ({ items }) } as FetchResponse;
    }
    if (url.match(/\/api\/v1\/secrets$/) && init?.method === "POST") {
      const body = JSON.parse(init.body ?? "{}") as { name: string; folderId: string | number; items: { slug: string; itemValue: string }[] };
      opts.capturedCreateFields?.(Object.fromEntries(body.items.filter((i) => i.itemValue).map((i) => [i.slug, i.itemValue])));
      opts.capturedCreateName?.(body.name);
      opts.capturedCreateFolderId?.(String(body.folderId));
      return { ok: true, status: 200, json: async () => ({ id: opts.createId ?? 90210 }) } as FetchResponse;
    }
    if (url.includes("/fields/") && init?.method === "PUT") {
      putUrls.push(url);
      opts.capturedPutUrls?.(putUrls);
      const slug = decodeURIComponent(url.split("/fields/")[1].split("?")[0]);
      if (opts.updateFails) {
        return { ok: false, status: 500, json: async () => ({ message: "boom" }) } as FetchResponse;
      }
      const value = (JSON.parse(init.body ?? "{}") as { value: string }).value;
      puts.push({ slug, value });
      opts.capturedUpdates?.(puts);
      return { ok: true, status: 200, json: async () => ({}) } as FetchResponse;
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as Fetcher;
}

// A fetcher that must NEVER be called — proves the kept-valid/already-vaulted no-op path makes zero
// network calls (no Delinea REST at all, only a local db read + an optional label-stamp upsert).
const throwingFetcher: Fetcher = (async (url: string) => {
  throw new Error(`unexpected fetch (should never be called): ${url}`);
}) as Fetcher;

function fakeDb(opts: { existingSecret?: { externalId: string; label?: string | null } | null } = {}) {
  const calls: { upsert: unknown[]; clientUpdate: unknown[] } = { upsert: [], clientUpdate: [] };
  const db = {
    secret: {
      findUnique: async () => opts.existingSecret ?? null,
      findMany: async () => [],
      upsert: async (a: unknown) => { calls.upsert.push(a); return {}; },
    },
    clientSystem: { findMany: async () => [] },
    systemSetupState: { updateMany: async () => {} },
    auditLog: { create: async () => {} },
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
    client: {
      update: async (a: unknown) => { calls.clientUpdate.push(a); },
    },
  };
  return { db: db as unknown as PrismaClient, calls };
}

test("googleLabeledValues: exact field mapping, defaults customerId to my_customer", () => {
  assert.deepEqual(
    googleLabeledValues({ keyBase64: "ZmFrZQ==", saEmail: "iam-engine@proj.iam.gserviceaccount.com", impersonate: "admin@acme.com" }),
    { ClientID: "my_customer", ClientSecret: "ZmFrZQ==", accountid: "iam-engine@proj.iam.gserviceaccount.com", apiURL: "admin@acme.com" }
  );
});

test("googleLabeledValues: an explicit customerId wins over the my_customer default", () => {
  assert.deepEqual(
    googleLabeledValues({ keyBase64: "ZmFrZQ==", saEmail: "sa@proj.iam.gserviceaccount.com", impersonate: "admin@acme.com", customerId: "C0123456" }),
    { ClientID: "C0123456", ClientSecret: "ZmFrZQ==", accountid: "sa@proj.iam.gserviceaccount.com", apiURL: "admin@acme.com" }
  );
});

test("GOOGLE_SECRET_NAME is the exact literal Delinea secret name", () => {
  assert.equal(GOOGLE_SECRET_NAME, "Google API - IAM Engine");
});

// FINDING 1 analog: credState "kept-valid" but nothing vaulted -> stranded, ok:false, never a silent
// success (core re-provisions with needKey:true).
test("kept-valid + nothing vaulted -> stranded, ok:false, no Delinea calls at all", async () => {
  const { db, calls } = fakeDb({ existingSecret: null });
  const r = await writeGoogleWorkspaceCreds({
    db,
    client: CLIENT,
    provision: provision({ credState: "kept-valid", keyBase64: undefined }),
    impersonate: "admin@acme.com",
    env: ENV_CONFIGURED,
  });
  assert.equal(r.ok, false);
  assert.equal(r.stranded, true);
  assert.match(r.error, /valid.*but none is vaulted|unrecoverable/);
  assert.equal(calls.upsert.length, 0);
});

test("kept-valid + REPLACE_ME placeholder -> stranded (a placeholder id is not a real vaulted secret)", async () => {
  const { db, calls } = fakeDb({ existingSecret: { externalId: "REPLACE_ME" } });
  const r = await writeGoogleWorkspaceCreds({
    db,
    client: CLIENT,
    provision: provision({ credState: "kept-valid", keyBase64: undefined }),
    impersonate: "admin@acme.com",
    env: ENV_CONFIGURED,
  });
  assert.equal(r.ok, false);
  assert.equal(r.stranded, true);
  assert.ok(!r.error.includes("REPLACE_ME"), "must never surface the placeholder as if it were the vaulted id");
  assert.equal(calls.upsert.length, 0);
});

test("kept-valid + already vaulted, label already stamped -> true no-op, zero Delinea network calls", async () => {
  const { db, calls } = fakeDb({ existingSecret: { externalId: "SS-already", label: "Google service account (auto)" } });
  const r = await writeGoogleWorkspaceCreds({
    db,
    client: CLIENT,
    provision: provision({ credState: "kept-valid", keyBase64: undefined }),
    impersonate: "admin@acme.com",
    fetch: throwingFetcher,
    env: ENV_CONFIGURED,
  });
  assert.deepEqual(r, { ok: true, externalId: "SS-already", actions: [] });
  assert.equal(calls.upsert.length, 0);
});

test("kept-valid + vaulted but un-labelled -> stamps the (auto) label only, zero Delinea network calls", async () => {
  const { db, calls } = fakeDb({ existingSecret: { externalId: "SS-already", label: null } });
  const r = await writeGoogleWorkspaceCreds({
    db,
    client: CLIENT,
    provision: provision({ credState: "kept-valid", keyBase64: undefined }),
    impersonate: "admin@acme.com",
    fetch: throwingFetcher,
    env: ENV_CONFIGURED,
  });
  assert.equal(r.ok, true);
  assert.equal(r.externalId, "SS-already");
  assert.equal(calls.upsert.length, 1);
  const entry = calls.upsert[0] as { update?: { label?: string }; create?: { label?: string } };
  assert.equal(entry.update?.label ?? entry.create?.label, "Google service account (auto)");
});

test("issued + no existing row -> creates the exact secret name in the Identity Services subfolder, then wires it", async () => {
  const { db, calls } = fakeDb({ existingSecret: null });
  let created: Record<string, string> = {};
  let createdName = "";
  let createdFolderId = "";
  const f = fetcher({
    childFolderId: 9001,
    createId: "70001",
    capturedCreateFields: (fields) => (created = fields),
    capturedCreateName: (n) => (createdName = n),
    capturedCreateFolderId: (id) => (createdFolderId = id),
  });
  const r = await writeGoogleWorkspaceCreds({
    db,
    client: CLIENT,
    provision: provision(),
    impersonate: "admin@acme.com",
    customerId: "C0123456",
    fetch: f,
    env: ENV_CONFIGURED,
  });
  assert.equal(r.ok, true);
  assert.equal(r.externalId, "70001");
  assert.equal(createdName, GOOGLE_SECRET_NAME);
  assert.equal(createdFolderId, "9001", "must land in the client's Identity Services subfolder, not the root (142)");
  assert.equal(created.clientid, "C0123456");
  assert.equal(created.clientsecret, "ZmFrZWtleQ==");
  assert.equal(created.accountid, "iam-engine@ctg-iam-acme.iam.gserviceaccount.com");
  assert.equal(created.apiurl, "admin@acme.com");
  assert.equal(calls.upsert.length, 1);
  const entry = calls.upsert[0] as { update?: { externalId?: string; label?: string }; create?: { externalId?: string; label?: string; name?: string } };
  const externalId = entry.create?.externalId ?? entry.update?.externalId;
  assert.equal(externalId, "70001");
  assert.equal(entry.create?.label ?? entry.update?.label, "Google service account (auto)");
});

// No "Identity Services" child folder found -> REFUSE, never fall back to the client ROOT (a root
// secret's narrower permissions make it unviewable to the team).
test("issued + no Identity Services subfolder -> refuses, never writes to the client root", async () => {
  const { db, calls } = fakeDb({ existingSecret: null });
  let createdFolderId = "";
  const f = fetcher({ createId: "1", capturedCreateFolderId: (id) => (createdFolderId = id) }); // no childFolderId => no Identity Services child
  const r = await writeGoogleWorkspaceCreds({ db, client: CLIENT, provision: provision(), impersonate: "admin@acme.com", fetch: f, env: ENV_CONFIGURED });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /Identity Services|subfolder|root/i);
  assert.equal(createdFolderId, "", "create POST must never fire — nothing written to the root (142)");
  assert.equal(calls.upsert.length, 0, "nothing wired onto the client");
});

test("issued + existing real row -> updates in place, createSecret never called", async () => {
  const { db, calls } = fakeDb({ existingSecret: { externalId: "SS-500", label: "Google service account (auto)" } });
  let createCalled = false;
  let putUrls: string[] = [];
  const f = fetcher({ createCalled: () => (createCalled = true), capturedPutUrls: (u) => (putUrls = u) });
  const r = await writeGoogleWorkspaceCreds({ db, client: CLIENT, provision: provision(), impersonate: "admin@acme.com", fetch: f, env: ENV_CONFIGURED });
  assert.equal(r.ok, true);
  assert.equal(r.externalId, "SS-500");
  assert.equal(createCalled, false);
  assert.ok(putUrls.length > 0);
  assert.ok(putUrls.every((u) => u.includes("/api/v1/secrets/SS-500/fields/")));
  assert.equal(calls.upsert.length, 1);
});

test("issued + existing row is a REPLACE_ME placeholder -> CREATE a real secret, never PUT to REPLACE_ME", async () => {
  const { db, calls } = fakeDb({ existingSecret: { externalId: "REPLACE_ME" } });
  let createCalled = false;
  let putUrls: string[] = [];
  const f = fetcher({ createCalled: () => (createCalled = true), capturedPutUrls: (u) => (putUrls = u), createId: "55555", childFolderId: 9001 });
  const r = await writeGoogleWorkspaceCreds({ db, client: CLIENT, provision: provision(), impersonate: "admin@acme.com", fetch: f, env: ENV_CONFIGURED });
  assert.equal(r.ok, true);
  assert.equal(r.externalId, "55555");
  assert.equal(createCalled, true);
  assert.ok(!putUrls.some((u) => u.includes("/secrets/REPLACE_ME/")));
  assert.equal(calls.upsert.length, 1);
});

test("issued + Delinea write not configured -> refuses with what's missing, before any Delinea write call", async () => {
  const { db, calls } = fakeDb();
  const r = await writeGoogleWorkspaceCreds({ db, client: CLIENT, provision: provision(), impersonate: "admin@acme.com", env: ENV_NOT_CONFIGURED });
  assert.equal(r.ok, false);
  assert.match(r.error, /not configured/);
  assert.match(r.error, /write account|template/);
  assert.equal(calls.upsert.length, 0);
});

test("Delinea write auth failure -> ok:false, nothing persisted", async () => {
  const { db, calls } = fakeDb();
  const f: Fetcher = (async (url: string) => {
    if (url.includes("/oauth2/token")) return { ok: false, status: 401, json: async () => ({}) } as FetchResponse;
    throw new Error(`unexpected fetch: ${url}`);
  }) as Fetcher;
  const r = await writeGoogleWorkspaceCreds({ db, client: CLIENT, provision: provision(), impersonate: "admin@acme.com", fetch: f, env: ENV_CONFIGURED });
  assert.equal(r.ok, false);
  assert.match(r.error, /Delinea write auth failed/);
  assert.equal(calls.upsert.length, 0);
});

test("createSecret failure -> ok:false with an actions trail, key material never echoed", async () => {
  const { db, calls } = fakeDb({ existingSecret: null });
  const f = fetcher({ createFails: true, childFolderId: 9001 }); // subfolder resolves; the CREATE itself fails
  const r = await writeGoogleWorkspaceCreds({
    db,
    client: CLIENT,
    provision: provision({ keyBase64: "SUPERSECRETKEYMATERIAL" }),
    impersonate: "admin@acme.com",
    fetch: f,
    env: ENV_CONFIGURED,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /no template access|Delinea/);
  assert.ok(!r.error.includes("SUPERSECRETKEYMATERIAL"));
  assert.ok(!r.actions.some((a) => a.includes("SUPERSECRETKEYMATERIAL")));
  assert.equal(calls.upsert.length, 0);
});

test("updateSecretFields failure (existing row) -> ok:false, nothing persisted, key material never echoed", async () => {
  const { db, calls } = fakeDb({ existingSecret: { externalId: "SS-1" } });
  const f = fetcher({ updateFails: true });
  const r = await writeGoogleWorkspaceCreds({
    db,
    client: CLIENT,
    provision: provision({ keyBase64: "SUPERSECRETKEYMATERIAL" }),
    impersonate: "admin@acme.com",
    fetch: f,
    env: ENV_CONFIGURED,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /boom|Delinea/);
  assert.ok(!r.error.includes("SUPERSECRETKEYMATERIAL"));
  assert.equal(calls.upsert.length, 0);
});

test("updateSecretFields failure (create path) -> ok:false, nothing persisted", async () => {
  const { db, calls } = fakeDb({ existingSecret: null });
  const f = fetcher({ updateFails: true, childFolderId: 9001 }); // subfolder resolves + create ok; the field PUT fails
  const r = await writeGoogleWorkspaceCreds({ db, client: CLIENT, provision: provision(), impersonate: "admin@acme.com", fetch: f, env: ENV_CONFIGURED });
  assert.equal(r.ok, false);
  assert.match(r.error, /boom|Delinea/);
  assert.equal(calls.upsert.length, 0);
});

test("self-learns delineaFolderId when the client had none", async () => {
  const CLIENT_NO_FOLDER: WriteGoogleClientInput = { ...CLIENT, delineaFolderId: null };
  const { db, calls } = fakeDb({ existingSecret: null });
  const f = fetcher({ createId: "1", childFolderId: 501 }); // Identity Services subfolder present
  const env = { ...ENV_CONFIGURED, DELINEA_FOLDER_MAP: JSON.stringify({ acme: "500" }) };
  const r = await writeGoogleWorkspaceCreds({ db, client: CLIENT_NO_FOLDER, provision: provision(), impersonate: "admin@acme.com", fetch: f, env });
  assert.equal(r.ok, true);
  assert.equal(calls.clientUpdate.length, 1);
  const upd = calls.clientUpdate[0] as { data: { delineaFolderId?: string } };
  assert.equal(upd.data.delineaFolderId, "500");
});

test("fields sent to Delinea never include an undefined value", async () => {
  const { db } = fakeDb({ existingSecret: null });
  let created: Record<string, string> = {};
  const f = fetcher({ capturedCreateFields: (fields) => (created = fields), childFolderId: 9001 }); // Identity Services subfolder present
  const r = await writeGoogleWorkspaceCreds({ db, client: CLIENT, provision: provision(), impersonate: "admin@acme.com", fetch: f, env: ENV_CONFIGURED });
  assert.equal(r.ok, true);
  assert.equal(created.clientid, "my_customer"); // default, since no customerId was passed
  assert.equal(created.clientsecret, "ZmFrZWtleQ==");
});
