import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import type { Fetcher, FetchResponse } from "./delinea";
import { writeProvisionedM365App, autoLabel, type WriteClientInput } from "./write-m365-app";
import type { ProvisionResult } from "./provision-m365-app";

const CLIENT: WriteClientInput = { id: "client1", slug: "acme", name: "Acme Corp", delineaFolderId: "142", primaryDomain: "acme.com" };

// Default credState is "issued" — most tests here exercise a freshly-minted credential that must be
// vaulted. Tests exercising the "kept-valid" / "unverified" contract override it explicitly.
function provision(overrides: Partial<ProvisionResult> = {}): ProvisionResult {
  return {
    appId: "app-guid-1",
    objectId: "obj-guid-1",
    spId: "sp-guid-1",
    tenantId: "acme.onmicrosoft.com",
    created: false,
    granted: [],
    gaps: [],
    optionalGaps: [],
    verified: true,
    exchangeReady: true,
    credState: "issued",
    actions: [],
    ...overrides,
  };
}

// Env with a write account + template configured, folder resolved from the client itself.
const ENV_CONFIGURED = {
  DELINEA_BASE_URL: "https://ctg.secretservercloud.com",
  DELINEA_WRITE_USER: "svc-write",
  DELINEA_WRITE_PASSWORD: "pw",
  DELINEA_TEMPLATE_M365_ADMIN: "6001",
};
const ENV_NOT_CONFIGURED = { DELINEA_BASE_URL: "https://ctg.secretservercloud.com" };

// Routes: the Entra probe (login.microsoftonline.com), Delinea oauth2/token, the dedup search, the
// template stub, the create POST, and the per-field PUT. `probeOk` controls the Entra grant's verdict.
function fetcher(opts: {
  probeOk?: boolean;
  searchRecords?: { id: number | string; name: string }[];
  createId?: number | string;
  capturedCreateFields?: (fields: Record<string, string>) => void;
  capturedUpdates?: (calls: { slug: string; value: string }[]) => void;
  probeCalled?: () => void;
  createCalled?: () => void;
  createFails?: boolean;
  updateFails?: boolean;
  putFailsForSlugs?: string[]; // simulate a template that 400s PUT for specific slugs only (e.g. no cert field)
  capturedPutUrls?: (urls: string[]) => void;
  // Raw items served for the kept-valid completeness read (GET /secrets/{id}?autoComment=...).
  // Unset -> that GET falls through to "unexpected fetch" (read fails -> fail-safe "unknown").
  vaultItems?: Array<{ slug: string; itemValue?: string | null }>;
} = {}): Fetcher {
  const putUrls: string[] = [];
  const puts: { slug: string; value: string }[] = [];
  return (async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    if (url.includes("login.microsoftonline.com")) {
      opts.probeCalled?.();
      const ok = opts.probeOk ?? true;
      return ok
        ? ({ ok: true, status: 200, json: async () => ({ access_token: "graph-tok" }) } as FetchResponse)
        : ({ ok: false, status: 401, json: async () => ({ error: "invalid_client", error_description: "AADSTS7000215: bad secret" }) } as FetchResponse);
    }
    if (url.includes("/oauth2/token")) {
      return { ok: true, status: 200, json: async () => ({ access_token: "delinea-tok" }) } as FetchResponse;
    }
    if (url.includes("filter.folderId")) {
      return { ok: true, status: 200, json: async () => ({ records: opts.searchRecords ?? [] }) } as FetchResponse;
    }
    if (url.includes("/secrets/stub")) {
      opts.createCalled?.();
      if (opts.createFails) {
        return { ok: false, status: 403, json: async () => ({ message: "no template access" }) } as FetchResponse;
      }
      // Stub items keyed by the slugs defaultFieldMap derives from field-requirements' m365-admin anyOf[0]s.
      const items = ["username", "password", "tenantid", "certificatebase64", "certificatepassword", "certificatethumbprint"].map((slug, i) => ({
        fieldId: i + 1,
        slug,
        itemValue: "",
      }));
      return { ok: true, status: 200, json: async () => ({ items }) } as FetchResponse;
    }
    if (opts.vaultItems && /\/api\/v1\/secrets\/[^/]+\?autoComment=/.test(url) && (!init?.method || init.method === "GET")) {
      return { ok: true, status: 200, json: async () => ({ items: opts.vaultItems }) } as FetchResponse;
    }
    if (url.match(/\/api\/v1\/secrets$/) && init?.method === "POST") {
      const body = JSON.parse(init.body ?? "{}") as { items: { slug: string; itemValue: string }[] };
      opts.capturedCreateFields?.(Object.fromEntries(body.items.filter((i) => i.itemValue).map((i) => [i.slug, i.itemValue])));
      return { ok: true, status: 200, json: async () => ({ id: opts.createId ?? 90210 }) } as FetchResponse;
    }
    if (url.includes("/fields/") && init?.method === "PUT") {
      putUrls.push(url);
      opts.capturedPutUrls?.(putUrls);
      const slug = decodeURIComponent(url.split("/fields/")[1].split("?")[0]); // strip the ?autoComment= query
      if (opts.updateFails || opts.putFailsForSlugs?.includes(slug)) {
        return { ok: false, status: opts.updateFails ? 500 : 400, json: async () => ({ message: opts.updateFails ? "boom" : "field not supported by this template" }) } as FetchResponse;
      }
      const value = (JSON.parse(init.body ?? "{}") as { value: string }).value;
      puts.push({ slug, value });
      opts.capturedUpdates?.(puts);
      return { ok: true, status: 200, json: async () => ({}) } as FetchResponse;
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as Fetcher;
}

// Fake db: db.secret.findUnique (existing-row check), db.client.update (self-learn folder), and
// everything makeClientRepository(db).upsertSecrets touches.
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

test("happy path create: writes appId/secret/tenant + cert fields, persists the reference", async () => {
  const { db, calls } = fakeDb();
  let created: Record<string, string> = {};
  let updates: { slug: string; value: string }[] = [];
  const f = fetcher({
    capturedCreateFields: (fields) => (created = fields),
    capturedUpdates: (u) => (updates = u),
  });
  const r = await writeProvisionedM365App(
    { client: CLIENT, provision: provision({ clientSecret: "shh", certBase64: "cGZ4", certPassword: "certpw" }) },
    { db, fetch: f, env: ENV_CONFIGURED }
  );
  assert.deepEqual(r, { ok: true, externalId: "90210", created: true, updated: false, wroteCreds: true, warnings: undefined });
  // createSecret's stub-fill got every field.
  assert.equal(created.username, "app-guid-1");
  assert.equal(created.password, "shh");
  assert.equal(created.tenantid, "acme.onmicrosoft.com");
  assert.equal(created.certificatebase64, "cGZ4");
  assert.equal(created.certificatepassword, "certpw");
  // updateSecretFields pushed the same values as a follow-up (covers the "secret already existed" case).
  const bySlug = Object.fromEntries(updates.map((u) => [u.slug, u.value]));
  assert.equal(bySlug.username, "app-guid-1");
  assert.equal(bySlug.password, "shh");
  assert.equal(bySlug.certificatebase64, "cGZ4");
  // Never leaked a value into anything but the Delinea PUT body — no thumbprint field written (not on ProvisionResult).
  assert.equal("certificatethumbprint" in bySlug, false);
  // Persisted the reference (never a value) onto the client.
  assert.equal(calls.upsert.length, 1);
  const entry = calls.upsert[0] as { update?: { externalId?: string }; create?: { externalId?: string } };
  const externalId = entry.create?.externalId ?? entry.update?.externalId;
  assert.equal(externalId, "90210");
});

test("secret already existed for this client -> reported as updated, not created", async () => {
  const { db } = fakeDb({ existingSecret: { externalId: "SS-999" } });
  const r = await writeProvisionedM365App(
    { client: CLIENT, provision: provision({ clientSecret: "shh" }) },
    { db, fetch: fetcher(), env: ENV_CONFIGURED }
  );
  assert.equal(r.ok, true);
  assert.equal(r.created, false);
  assert.equal(r.updated, true);
  assert.equal(r.externalId, "SS-999");
});

// FINDING FIX: a client whose m365-admin secret was already vaulted (e.g. created via the manual UI,
// named `${client.name} — ${secretName}`) must be updated IN PLACE by its known externalId — never
// re-discovered by a name search (createSecret's find-or-create), which would miss a naming mismatch
// and mint a second, orphaned Secret Server entry.
test("existing-row short-circuit: known externalId is updated directly, createSecret is never called, and the reference is unchanged", async () => {
  const { db, calls } = fakeDb({ existingSecret: { externalId: "SS-123" } });
  let createCalled = false;
  let putUrls: string[] = [];
  const f = fetcher({
    createCalled: () => (createCalled = true),
    capturedPutUrls: (urls) => (putUrls = urls),
  });
  const r = await writeProvisionedM365App(
    { client: CLIENT, provision: provision({ clientSecret: "shh" }) },
    { db, fetch: f, env: ENV_CONFIGURED }
  );
  assert.equal(r.ok, true);
  assert.equal(r.updated, true);
  assert.equal(r.created, false);
  assert.equal(r.externalId, "SS-123");
  assert.equal(createCalled, false); // createSecret's stub call never happened — no dedup name search, no create
  assert.ok(putUrls.length > 0);
  assert.ok(putUrls.every((u) => u.includes("/api/v1/secrets/SS-123/fields/"))); // updateSecretFields hit the KNOWN id directly
  // upsertSecrets persisted the SAME externalId that was already vaulted — unchanged.
  assert.equal(calls.upsert.length, 1);
  const entry = calls.upsert[0] as { update?: { externalId?: string }; create?: { externalId?: string } };
  assert.equal(entry.create?.externalId ?? entry.update?.externalId, "SS-123");
});

test("no existing row -> create path: createSecret runs, then updateSecretFields, reported as created", async () => {
  const { db, calls } = fakeDb({ existingSecret: null });
  let createCalled = false;
  let updateCalled = false;
  const f = fetcher({
    createCalled: () => (createCalled = true),
    capturedUpdates: () => (updateCalled = true),
    createId: "77001",
  });
  const r = await writeProvisionedM365App(
    { client: CLIENT, provision: provision({ clientSecret: "shh" }) },
    { db, fetch: f, env: ENV_CONFIGURED }
  );
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.equal(r.updated, false);
  assert.equal(r.externalId, "77001");
  assert.equal(createCalled, true);
  assert.equal(updateCalled, true);
  assert.equal(calls.upsert.length, 1);
});

test("createSecret failure (no existing row) -> ok:false, nothing persisted", async () => {
  const { db, calls } = fakeDb({ existingSecret: null });
  const f = fetcher({ createFails: true });
  const r = await writeProvisionedM365App(
    { client: CLIENT, provision: provision({ clientSecret: "shh" }) },
    { db, fetch: f, env: ENV_CONFIGURED }
  );
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /no template access|Delinea/);
  assert.equal(calls.upsert.length, 0);
});

test("updateSecretFields failure (existing row) -> ok:false, nothing persisted", async () => {
  const { db, calls } = fakeDb({ existingSecret: { externalId: "SS-123" } });
  const f = fetcher({ updateFails: true });
  const r = await writeProvisionedM365App(
    { client: CLIENT, provision: provision({ clientSecret: "shh" }) },
    { db, fetch: f, env: ENV_CONFIGURED }
  );
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /boom|Delinea/);
  assert.equal(calls.upsert.length, 0);
});

test("updateSecretFields failure (create path) -> ok:false, nothing persisted", async () => {
  const { db, calls } = fakeDb({ existingSecret: null });
  const f = fetcher({ updateFails: true });
  const r = await writeProvisionedM365App(
    { client: CLIENT, provision: provision({ clientSecret: "shh" }) },
    { db, fetch: f, env: ENV_CONFIGURED }
  );
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /boom|Delinea/);
  assert.equal(calls.upsert.length, 0);
});

// FIX (propagation tolerance): a newly issued client secret failing the probe with a propagation-class
// error (AADSTS7000215/invalid_client here) is no longer refused outright — after the retry window it's
// vaulted anyway with a warning, since the Graph-issued secret is real and refusing to vault it strands
// it. See the two propagation-retry tests below for the full retry/backoff contract.
test("a newly issued client secret that fails the Entra probe (propagation-class) is still vaulted, with a warning", async () => {
  const { db, calls } = fakeDb();
  let createCalled = false;
  const f = fetcher({ probeOk: false, capturedCreateFields: () => (createCalled = true) });
  const r = await writeProvisionedM365App(
    { client: CLIENT, provision: provision({ clientSecret: "bad-secret" }) },
    { db, fetch: f, env: ENV_CONFIGURED, sleep: async () => {} }
  );
  assert.equal(r.ok, true);
  assert.equal(r.wroteCreds, true);
  assert.ok(r.warnings?.some((w) => w.includes("propagation")));
  assert.equal(createCalled, true);
  assert.equal(calls.upsert.length, 1);
});

// FIX (propagation tolerance): the probe transiently fails twice with a propagation-class error, then
// succeeds on the third attempt — the secret is vaulted as a normal verified write, no warning, and the
// injected sleep was invoked for each retry gap.
test("propagation retry: probe fails twice (invalid_client) then succeeds -> vaults, verified, no warning, sleep called", async () => {
  const { db, calls } = fakeDb();
  let callCount = 0;
  let sleepCalls = 0;
  const f: Fetcher = (async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    if (url.includes("login.microsoftonline.com")) {
      callCount++;
      if (callCount < 3) {
        return { ok: false, status: 401, json: async () => ({ error: "invalid_client", error_description: "AADSTS7000215: bad secret" }) } as FetchResponse;
      }
      return { ok: true, status: 200, json: async () => ({ access_token: "graph-tok" }) } as FetchResponse;
    }
    return fetcher()(url, init);
  }) as Fetcher;
  const r = await writeProvisionedM365App(
    { client: CLIENT, provision: provision({ clientSecret: "shh" }) },
    { db, fetch: f, env: ENV_CONFIGURED, sleep: async () => { sleepCalls++; } }
  );
  assert.equal(r.ok, true);
  assert.equal(r.wroteCreds, true);
  assert.equal(r.warnings, undefined);
  assert.equal(callCount, 3);
  assert.equal(sleepCalls, 2);
  assert.equal(calls.upsert.length, 1);
});

// FIX (propagation tolerance): the probe NEVER succeeds (persistent propagation-class failure) — after
// exhausting the retry window, the secret is vaulted anyway (never stranded) with a warning that says so.
test("propagation retry: probe always fails (invalid_client) -> vaults anyway with the propagation warning, ok:true wroteCreds:true, never stranded/ok:false", async () => {
  const { db, calls } = fakeDb();
  let probeCount = 0;
  const f = fetcher({ probeOk: false, probeCalled: () => probeCount++ });
  const r = await writeProvisionedM365App(
    { client: CLIENT, provision: provision({ clientSecret: "shh" }) },
    { db, fetch: f, env: ENV_CONFIGURED, sleep: async () => {} }
  );
  assert.equal(r.ok, true);
  assert.equal(r.wroteCreds, true);
  assert.equal(r.stranded, undefined);
  assert.ok(r.warnings, "expected the propagation warning to be surfaced");
  assert.ok(r.warnings!.some((w) => w.includes("propagation")));
  assert.equal(probeCount, 6, "should have retried up to the max attempt count");
  assert.equal(calls.upsert.length, 1);
});

test("credState kept-valid + already vaulted (label already stamped) -> no-op, no Delinea calls at all", async () => {
  // Label already carries "(auto)", so nothing at all changes — the true settled no-op.
  const { db, calls } = fakeDb({ existingSecret: { externalId: "SS-already-vaulted", label: "M365 app registration (auto)" } });
  let probed = false;
  const f = fetcher({ probeCalled: () => (probed = true), vaultItems: [{ slug: "certificatebase64", itemValue: "present-pfx" }] });
  const r = await writeProvisionedM365App(
    { client: CLIENT, provision: provision({ credState: "kept-valid" }) /* no clientSecret, no certBase64 */ },
    { db, fetch: f, env: ENV_CONFIGURED }
  );
  // Surfaces the already-vaulted secret id so the audit/run log can name which credential is wired.
  assert.deepEqual(r, { ok: true, wroteCreds: false, externalId: "SS-already-vaulted" });
  assert.equal(probed, false);
  assert.equal(calls.upsert.length, 0);
});

test("credState kept-valid + already vaulted but UN-labelled -> stamps the (auto) wiring label (idempotent)", async () => {
  const { db, calls } = fakeDb({ existingSecret: { externalId: "SS-already-vaulted", label: null } });
  const r = await writeProvisionedM365App(
    { client: CLIENT, provision: provision({ credState: "kept-valid" }) },
    { db, fetch: fetcher({ vaultItems: [{ slug: "certificatebase64", itemValue: "present-pfx" }] }), env: ENV_CONFIGURED }
  );
  assert.deepEqual(r, { ok: true, wroteCreds: false, externalId: "SS-already-vaulted" });
  assert.equal(calls.upsert.length, 1, "the label-only stamp is written once");
  const entry = calls.upsert[0] as { update?: { label?: string }; create?: { label?: string } };
  assert.equal(entry.update?.label ?? entry.create?.label, "M365 app registration (auto)");
});

// FINDING 1: the stranded case — the app registration reports a valid credential (credState
// "kept-valid") but the vault holds NOTHING for this client. That one-time secret is unrecoverable;
// silently reporting ok:true would tell an operator the client is "set up" when it cannot authenticate.
test("Finding 1: credState kept-valid but NOTHING vaulted -> stranded, ok:false, never a silent success", async () => {
  const { db, calls } = fakeDb({ existingSecret: null });
  let probed = false;
  const f = fetcher({ probeCalled: () => (probed = true) });
  const r = await writeProvisionedM365App(
    { client: CLIENT, provision: provision({ credState: "kept-valid" }) },
    { db, fetch: f, env: ENV_CONFIGURED }
  );
  assert.equal(r.ok, false);
  assert.equal(r.wroteCreds, false);
  assert.equal(r.stranded, true);
  assert.match(r.error ?? "", /valid credential but none is vaulted|unrecoverable/);
  assert.equal(probed, false, "a stranded kept-valid credential is never probed — there is nothing to probe");
  assert.equal(calls.upsert.length, 0);
});

// PLACEHOLDER externalId: ~106/137 clients carry an m365-admin Secret row whose externalId is the
// "REPLACE_ME" placeholder (or "") — the profile-generator/seed default for an un-wired secret. That is
// NOT a real Delinea id, so it must be treated as "nothing vaulted", not a live secret to update or
// report. secretIsSet() already draws that line for the rest of the app; the write must honour it too.
test("issued credState + existing row is a REPLACE_ME placeholder -> CREATE a real secret (not PUT to 'REPLACE_ME'), wire the real id", async () => {
  const { db, calls } = fakeDb({ existingSecret: { externalId: "REPLACE_ME" } });
  let createCalled = false;
  let putUrls: string[] = [];
  const f = fetcher({ createCalled: () => (createCalled = true), capturedPutUrls: (u) => (putUrls = u), createId: "55555" });
  const r = await writeProvisionedM365App(
    { client: CLIENT, provision: provision({ clientSecret: "shh" }) },
    { db, fetch: f, env: ENV_CONFIGURED }
  );
  assert.equal(r.ok, true);
  assert.equal(r.created, true, "a placeholder externalId is not a real secret — must CREATE, not update in place");
  assert.equal(r.externalId, "55555", "the real created id is wired, replacing the placeholder");
  assert.equal(createCalled, true, "createSecret must run");
  assert.ok(!putUrls.some((u) => u.includes("/secrets/REPLACE_ME/")), "must never PUT fields to secret id 'REPLACE_ME'");
  assert.equal(calls.upsert.length, 1);
});

// HALF-VAULTED credential (the 56977 case): the vault row is real and the app's creds are valid, but a
// prior secret-only rotation left the CERT fields empty — and every later run read "kept-valid" and
// no-op'd, so the missing cert could never self-heal. The kept-valid path now reads the vault row's
// cert slug and treats template-supported-but-EMPTY as stranded (recovery rotates both + re-vaults).
test("kept-valid + real row but the vault's cert slug is EMPTY -> stranded (half-vaulted, must rotate to complete)", async () => {
  const { db } = fakeDb({ existingSecret: { externalId: "56977" } });
  const f = fetcher({
    vaultItems: [
      { slug: "username", itemValue: "app-guid-1" },
      { slug: "password", itemValue: "some-secret" },
      { slug: "certificatebase64", itemValue: "" }, // template supports it — never written
      { slug: "certificatepassword", itemValue: null },
    ],
  });
  const r = await writeProvisionedM365App(
    { client: CLIENT, provision: provision({ credState: "kept-valid" }) },
    { db, fetch: f, env: ENV_CONFIGURED }
  );
  assert.equal(r.ok, false);
  assert.equal(r.stranded, true, "an empty cert slug on a supported template = half-vaulted -> stranded");
  assert.match(r.error ?? "", /no certificate material|certificatebase64/);
});

test("kept-valid + empty cert slug but expectCert=false (client-secret-only app) -> ok, NOT stranded", async () => {
  const { db } = fakeDb({ existingSecret: { externalId: "SS-secretonly" } });
  const f = fetcher({
    vaultItems: [
      { slug: "username", itemValue: "app-guid-1" },
      { slug: "password", itemValue: "some-secret" },
      { slug: "certificatebase64", itemValue: "" }, // empty is EXPECTED here — no cert was ever wanted
    ],
  });
  const r = await writeProvisionedM365App(
    { client: CLIENT, provision: provision({ credState: "kept-valid" }), expectCert: false },
    { db, fetch: f, env: ENV_CONFIGURED }
  );
  assert.deepEqual(r, { ok: true, wroteCreds: false, externalId: "SS-secretonly" });
});

test("kept-valid + real row, template has NO cert slug (password-only) -> ok, NOT stranded (Finding 5 semantics)", async () => {
  const { db } = fakeDb({ existingSecret: { externalId: "SS-pwonly" } });
  const f = fetcher({
    vaultItems: [
      { slug: "username", itemValue: "app-guid-1" },
      { slug: "password", itemValue: "some-secret" },
      // no certificate slugs at all — the template legitimately doesn't carry them
    ],
  });
  const r = await writeProvisionedM365App(
    { client: CLIENT, provision: provision({ credState: "kept-valid" }) },
    { db, fetch: f, env: ENV_CONFIGURED }
  );
  assert.deepEqual(r, { ok: true, wroteCreds: false, externalId: "SS-pwonly" });
});

test("kept-valid + real row, vault read fails -> ok (fail-safe: never churn creds on an unreadable vault)", async () => {
  const { db } = fakeDb({ existingSecret: { externalId: "SS-unreadable" } });
  // no vaultItems -> the completeness GET hits 'unexpected fetch' and the check degrades to unknown
  const r = await writeProvisionedM365App(
    { client: CLIENT, provision: provision({ credState: "kept-valid" }) },
    { db, fetch: fetcher(), env: ENV_CONFIGURED }
  );
  assert.deepEqual(r, { ok: true, wroteCreds: false, externalId: "SS-unreadable" });
});

test("kept-valid credState + existing row is a REPLACE_ME placeholder -> stranded, ok:false (not a fake 'done' showing REPLACE_ME)", async () => {
  const { db, calls } = fakeDb({ existingSecret: { externalId: "REPLACE_ME" } });
  const r = await writeProvisionedM365App(
    { client: CLIENT, provision: provision({ credState: "kept-valid" }) },
    { db, fetch: fetcher(), env: ENV_CONFIGURED }
  );
  assert.equal(r.ok, false);
  assert.equal(r.stranded, true, "a placeholder id means nothing real is vaulted — stranded, so recovery re-issues");
  assert.notEqual(r.externalId, "REPLACE_ME", "must never surface the placeholder as the vaulted id");
  assert.equal(calls.upsert.length, 0);
});

// FINDING 1/2: credState "unverified" (the existing-credentials read failed) must never be reported as
// a success — we genuinely don't know whether a valid credential exists.
test("Finding 1: credState unverified -> ok:false, not treated as set up, no Delinea calls", async () => {
  const { db, calls } = fakeDb();
  let probed = false;
  const f = fetcher({ probeCalled: () => (probed = true) });
  const r = await writeProvisionedM365App(
    { client: CLIENT, provision: provision({ credState: "unverified" }) },
    { db, fetch: f, env: ENV_CONFIGURED }
  );
  assert.equal(r.ok, false);
  assert.equal(r.wroteCreds, false);
  assert.match(r.error ?? "", /could not verify|transient/);
  assert.equal(probed, false);
  assert.equal(calls.upsert.length, 0);
});

// FINDING 6: a newly created app with an unmet REQUIRED gap must never be vaulted/repointed — that
// would break a currently-working credential by pointing the vault row at a half-provisioned app.
test("Finding 6: created app with a required gap -> refused, not vaulted/repointed", async () => {
  const { db, calls } = fakeDb({ existingSecret: { externalId: "SS-currently-working" } });
  let probed = false;
  const f = fetcher({ probeCalled: () => (probed = true) });
  const r = await writeProvisionedM365App(
    { client: CLIENT, provision: provision({ created: true, verified: true, gaps: ["User.ReadWrite.All"], clientSecret: "shh" }) },
    { db, fetch: f, env: ENV_CONFIGURED }
  );
  assert.equal(r.ok, false);
  assert.equal(r.wroteCreds, false);
  assert.match(r.error ?? "", /unmet required Graph permissions/);
  assert.match(r.error ?? "", /User\.ReadWrite\.All/);
  assert.equal(probed, false, "must refuse before ever probing/writing");
  assert.equal(calls.upsert.length, 0);
});

test("Finding 6: created app that IS fully verified with no gaps -> writes normally", async () => {
  const { db, calls } = fakeDb({ existingSecret: null });
  const r = await writeProvisionedM365App(
    { client: CLIENT, provision: provision({ created: true, verified: true, gaps: [], clientSecret: "shh" }) },
    { db, fetch: fetcher(), env: ENV_CONFIGURED }
  );
  assert.equal(r.ok, true);
  assert.equal(r.wroteCreds, true);
  assert.equal(calls.upsert.length, 1);
});

test("write not configured -> refuses with what's missing, before any Delinea write call", async () => {
  const { db, calls } = fakeDb();
  const r = await writeProvisionedM365App(
    { client: CLIENT, provision: provision({ clientSecret: "shh" }) },
    { db, fetch: fetcher(), env: ENV_NOT_CONFIGURED }
  );
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /not configured/);
  assert.match(r.error ?? "", /write account|template/);
  assert.equal(calls.upsert.length, 0);
});

test("cert-only issue (no new client secret): skips the Entra probe, writes only appId/tenant/cert fields", async () => {
  const { db } = fakeDb();
  let probed = false;
  let created: Record<string, string> = {};
  const f = fetcher({ probeCalled: () => (probed = true), capturedCreateFields: (fields) => (created = fields) });
  const r = await writeProvisionedM365App(
    { client: CLIENT, provision: provision({ certBase64: "cGZ4", certPassword: "certpw" }) },
    { db, fetch: f, env: ENV_CONFIGURED }
  );
  assert.equal(r.ok, true);
  assert.equal(r.wroteCreds, true);
  assert.equal(probed, false); // no clientSecret issued -> nothing to probe
  assert.equal(created.username, "app-guid-1");
  assert.equal(created.tenantid, "acme.onmicrosoft.com");
  assert.equal(created.certificatebase64, "cGZ4");
  assert.equal(created.certificatepassword, "certpw");
  assert.equal("password" in created, false); // never wrote an undefined clientSecret
});

test("fields sent to Delinea never include an undefined value (only what this run actually issued)", async () => {
  const { db } = fakeDb();
  let created: Record<string, string> = {};
  const f = fetcher({ capturedCreateFields: (fields) => (created = fields) });
  // clientSecret issued, no cert this run (kept existing valid cert) -> cert fields absent, not blank.
  const r = await writeProvisionedM365App({ client: CLIENT, provision: provision({ clientSecret: "shh" }) }, { db, fetch: f, env: ENV_CONFIGURED });
  assert.equal(r.ok, true);
  assert.equal(created.password, "shh");
  assert.equal("certificatebase64" in created, false);
  assert.equal("certificatepassword" in created, false);
});

// FINDING 5: a password-only Secret Server template legitimately has no certificate slug — its field
// PUTs 400. That must be a WARNING, never a whole-run failure, as long as the REQUIRED fields (appId/
// clientSecret/tenantId) succeed.
test("Finding 5: password-only template — cert field PUTs 400, required PUTs ok -> ok:true, warns, doesn't fail the run", async () => {
  const { db, calls } = fakeDb({ existingSecret: null });
  const f = fetcher({ putFailsForSlugs: ["certificatebase64", "certificatepassword"] });
  const r = await writeProvisionedM365App(
    { client: CLIENT, provision: provision({ clientSecret: "shh", certBase64: "cGZ4", certPassword: "certpw" }) },
    { db, fetch: f, env: ENV_CONFIGURED }
  );
  assert.equal(r.ok, true);
  assert.equal(r.wroteCreds, true);
  assert.ok(r.warnings, "expected warnings to be surfaced");
  assert.ok(r.warnings!.some((w) => w.includes("certificatebase64")));
  assert.ok(r.warnings!.some((w) => w.includes("certificatepassword")));
  // required fields still landed and the reference was still persisted
  assert.equal(calls.upsert.length, 1);
});

// FINDING 5 (torn write): a REQUIRED field failing must fail the whole run, even if other fields
// (including optional ones) succeeded.
test("Finding 5: a REQUIRED field PUT failing fails the whole run even when optional fields succeed", async () => {
  const { db, calls } = fakeDb({ existingSecret: null });
  const f = fetcher({ putFailsForSlugs: ["tenantid"] });
  const r = await writeProvisionedM365App(
    { client: CLIENT, provision: provision({ clientSecret: "shh", certBase64: "cGZ4", certPassword: "certpw" }) },
    { db, fetch: f, env: ENV_CONFIGURED }
  );
  assert.equal(r.ok, false);
  assert.equal(r.wroteCreds, false);
  assert.match(r.error ?? "", /tenantid|Delinea|field not supported/);
  assert.equal(calls.upsert.length, 0);
});

// FINDING 7: an issued cert's thumbprint must reach the Delinea field labeled "certificate thumbprint".
test("Finding 7: an issued cert's thumbprint is written as an optional field", async () => {
  const { db } = fakeDb();
  let created: Record<string, string> = {};
  let updates: { slug: string; value: string }[] = [];
  const f = fetcher({ capturedCreateFields: (fields) => (created = fields), capturedUpdates: (u) => (updates = u) });
  const r = await writeProvisionedM365App(
    { client: CLIENT, provision: provision({ clientSecret: "shh", certBase64: "cGZ4", certPassword: "certpw", certThumbprint: "ABCDEF0123456789" }) },
    { db, fetch: f, env: ENV_CONFIGURED }
  );
  assert.equal(r.ok, true);
  assert.equal(created.certificatethumbprint, "ABCDEF0123456789");
  const bySlug = Object.fromEntries(updates.map((u) => [u.slug, u.value]));
  assert.equal(bySlug.certificatethumbprint, "ABCDEF0123456789");
});

// FINDING 7: no thumbprint issued this run (e.g. cert kept, not reissued) -> the field is simply absent.
test("Finding 7: no thumbprint this run -> field absent, not written as blank/undefined", async () => {
  const { db } = fakeDb();
  let created: Record<string, string> = {};
  const f = fetcher({ capturedCreateFields: (fields) => (created = fields) });
  const r = await writeProvisionedM365App({ client: CLIENT, provision: provision({ clientSecret: "shh" }) }, { db, fetch: f, env: ENV_CONFIGURED });
  assert.equal(r.ok, true);
  assert.equal("certificatethumbprint" in created, false);
});

test("autoLabel: blank/none -> a descriptive default with (auto)", () => {
  assert.equal(autoLabel(null), "M365 app registration (auto)");
  assert.equal(autoLabel(""), "M365 app registration (auto)");
  assert.equal(autoLabel("   "), "M365 app registration (auto)");
});
test("autoLabel: existing label -> appended once, never doubled", () => {
  assert.equal(autoLabel("M365 App Reg"), "M365 App Reg (auto)");
  assert.equal(autoLabel("M365 App Reg (auto)"), "M365 App Reg (auto)");
  assert.equal(autoLabel("Something (AUTO)"), "Something (AUTO)"); // case-insensitive, not re-appended
});
