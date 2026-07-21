# Guided API Setup (Mimecast / Spanning / Proofpoint) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each API-credential system a "Setup <system> API" item in the client Actions menu that guides the operator to create the vendor API app, live-verifies the resulting credential by connecting, then vaults + wires it — shipping Mimecast, Spanning, Proofpoint.

**Architecture:** A generic, per-system-configured guided flow reusing existing infrastructure: extend the `value-probe` registry with app-side connect checks; a small `api-setup-catalog` describes each system; one `GuidedApiSetup` modal (paste fields **or** existing Delinea id) posts to the existing create route (paste) or an extended test route (existing-id, verify-then-wire); the Actions menu renders an item per catalog system the client has, and gates the M365 item on m365/entra/exchange.

**Tech Stack:** Next.js (App Router, TypeScript), React, Prisma; PowerShell 7 runner (one small Proofpoint region read); `node:test` via `tsx`.

## Global Constraints

- Never log or return a credential VALUE — probes produce a verdict only (mirror `value-probe.ts` header).
- All verification is **app-side HTTP** (cloud SaaS) — no browser, no runner, unit-testable with an injected `fetch`.
- Reuse existing Delinea write primitives (`createSecret`/`updateSecretFields`/`templateFor`/`upsertSecrets`); no new Delinea plumbing, no DB migration.
- Changelog: append one file per ship to `web/lib/changelog/entries/`, register in `_registry.ts` (id-sorted); `time` = `TZ=America/New_York date +%H:%M` on a 15-min boundary.
- Tests run from `web/`: `node node_modules/.bin/tsx --test <file>`. Typecheck: `node node_modules/typescript/bin/tsc --noEmit`. (Symlink `node_modules` from the main checkout when in a worktree.)
- Runner change (Task 2 only): bump `runner/VERSION` (minor) and parse-check the ps1 with `~/.local/pwsh/pwsh`.

---

### Task 1: Value-probe entries for mimecast, spanning, proofpoint

**Files:**
- Modify: `web/lib/secrets/value-probe.ts` (add three `PROBERS` entries + field-pick helpers)
- Test: `web/lib/secrets/value-probe.test.ts` (extend)

**Interfaces:**
- Consumes: existing `ValueProbe`, `ProbeCtx`, `Prober`, `pickField` (from `m365-credential`).
- Produces: `PROBERS["mimecast"]`, `PROBERS["spanning"]`, `PROBERS["proofpoint"]` — each a `Prober` (blocking live). `probeSecretValues("mimecast"|"spanning"|"proofpoint", values, ctx, fetcher)` returns `{ probeable:true, blocking:true, ok, error?, label?, kind:"live" }`.

- [ ] **Step 1: Write the failing tests**

Append to `web/lib/secrets/value-probe.test.ts`:

```ts
import { probeSecretValues } from "./value-probe";

const okFetch = (status: number, body: unknown = {}): typeof fetch =>
  (async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })) as unknown as typeof fetch;

test("mimecast probe: a token response = ok", async () => {
  const r = await probeSecretValues("mimecast", { ClientId: "cid", ClientSecret: "sec" }, {}, okFetch(200, { access_token: "t" }));
  assert.equal(r.probeable, true); assert.equal(r.blocking, true); assert.equal(r.ok, true); assert.equal(r.kind, "live");
});
test("mimecast probe: 401 = not ok", async () => {
  const r = await probeSecretValues("mimecast", { ClientId: "cid", ClientSecret: "bad" }, {}, okFetch(401, { error: "invalid_client" }));
  assert.equal(r.ok, false);
});
test("mimecast probe: missing a field is refused before the network", async () => {
  const r = await probeSecretValues("mimecast", { ClientId: "cid" }, {}, okFetch(200));
  assert.equal(r.ok, false); assert.match(r.error ?? "", /client secret/i);
});
test("spanning probe: 2xx with Basic auth = ok", async () => {
  const r = await probeSecretValues("spanning", { ClientId: "acct", AccessToken: "tok", Region: "us" }, {}, okFetch(200, {}));
  assert.equal(r.ok, true);
});
test("spanning probe: 401 = not ok", async () => {
  const r = await probeSecretValues("spanning", { ClientId: "acct", AccessToken: "bad", Region: "us" }, {}, okFetch(401));
  assert.equal(r.ok, false);
});
test("proofpoint probe: 200 with X-User/X-Password + region + domain = ok", async () => {
  const r = await probeSecretValues("proofpoint", { "X-User": "a@x.com", "X-Password": "p", Region: "us1", Domain: "x.com" }, {}, okFetch(200, {}));
  assert.equal(r.ok, true);
});
test("proofpoint probe: no region -> not probeable (advisory), never a false red", async () => {
  const r = await probeSecretValues("proofpoint", { "X-User": "a@x.com", "X-Password": "p", Domain: "x.com" }, {}, okFetch(200));
  assert.equal(r.probeable, false);
});
test("proofpoint probe: domain falls back to the client's primary domain", async () => {
  let calledUrl = "";
  const spy = (async (u: string) => { calledUrl = u; return { ok: true, status: 200, json: async () => ({}) }; }) as unknown as typeof fetch;
  const r = await probeSecretValues("proofpoint", { "X-User": "a@x.com", "X-Password": "p", Region: "us1" }, { clientPrimaryDomain: "acme.com" }, spy);
  assert.equal(r.ok, true); assert.match(calledUrl, /\/orgs\/acme\.com\//);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node node_modules/.bin/tsx --test lib/secrets/value-probe.test.ts`
Expected: FAIL — the three probers don't exist yet (`probeable:false` for all).

- [ ] **Step 3: Add the probers**

In `web/lib/secrets/value-probe.ts`, add field-pick constants near the top (after the imports) and three `PROBERS` entries. Use `pickField` (already imported for m365):

```ts
const MIMECAST_ID_FIELDS = ["ClientID", "ClientId", "Client ID", "AppId", "Application ID", "Username"];
const MIMECAST_SECRET_FIELDS = ["ClientSecret", "Client Secret", "Secret", "API Key", "ApiKey", "AccessToken", "Token", "Password"];
const SPANNING_ID_FIELDS = ["ClientID", "ClientId", "Client ID", "Domain", "AccountID", "AccountId", "Account", "Tenant", "Username"];
const SPANNING_TOKEN_FIELDS = ["ClientSecret", "AccessToken", "Access Token", "ApiToken", "APIKey", "Api Key", "ApiKey", "Token", "Key", "Password"];
const SPANNING_REGION_FIELDS = ["apiURL", "ApiUrl", "ApiURL", "BaseUrl", "Base URL", "Url", "URL", "Region"];
const PROOFPOINT_USER_FIELDS = ["X-User", "Username", "AdminUser", "Admin", "Email", "User"];
const PROOFPOINT_PASS_FIELDS = ["X-Password", "Password", "AdminPassword", "Secret", "ApiKey", "API Key", "Token"];
const PROOFPOINT_DOMAIN_FIELDS = ["Domain", "OrgDomain", "Org", "Tenant"];
const PROOFPOINT_REGION_FIELDS = ["Region", "apiURL", "ApiUrl", "BaseUrl", "Base URL", "Url", "URL"];

// Spanning region -> API base. A full URL in the region field wins; else map the short region.
function spanningBase(region: string): string {
  const v = (region || "us").trim();
  if (/^https?:\/\//i.test(v)) return v.replace(/\/+$/, "");
  return `https://o365-api-${v.toLowerCase()}.spanningbackup.com/external`;
}
// Proofpoint region -> API base. A full URL wins; else map us1..us5/eu1/au1.
function proofpointBase(region: string): string | null {
  const v = (region || "").trim();
  if (/^https?:\/\//i.test(v)) return v.replace(/\/+$/, "") + (/\/api\/v1$/.test(v) ? "" : "/api/v1");
  if (/^(us[1-5]|eu1|au1)$/i.test(v)) return `https://${v.toLowerCase()}.proofpointessentials.com/api/v1`;
  return null;
}
```

Add to the `PROBERS` object:

```ts
  // Mimecast API 2.0 — the exact OAuth2 client-credentials grant Connect-CtgMimecast runs.
  "mimecast": async (values, _ctx, fetcher) => {
    const id = pickField(values, MIMECAST_ID_FIELDS);
    const secret = pickField(values, MIMECAST_SECRET_FIELDS);
    if (!id || !secret) return { probeable: true, blocking: true, ok: false, error: `missing ${!id ? "client id" : "client secret"}`, kind: "live" };
    try {
      const res = await fetcher("https://api.services.mimecast.com/oauth/token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }).toString(),
      });
      const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
      return res.ok && body.access_token
        ? { probeable: true, blocking: true, ok: true, label: "authenticated to Mimecast (API 2.0)", kind: "live" }
        : { probeable: true, blocking: true, ok: false, error: body.error_description ?? body.error ?? `Mimecast token request failed (${res.status})`, hint: "check the 2.0 app's Client ID + Client Secret", kind: "live" };
    } catch (e) { return { probeable: true, blocking: true, ok: false, error: (e as Error).message, kind: "live" }; }
  },
  // Spanning Backup API — Basic auth (client id : token) against the region base.
  "spanning": async (values, _ctx, fetcher) => {
    const id = pickField(values, SPANNING_ID_FIELDS);
    const token = pickField(values, SPANNING_TOKEN_FIELDS);
    if (!id || !token) return { probeable: true, blocking: true, ok: false, error: `missing ${!id ? "account / api user" : "api token"}`, kind: "live" };
    const base = spanningBase(pickField(values, SPANNING_REGION_FIELDS) ?? "us");
    const auth = "Basic " + Buffer.from(`${id}:${token}`).toString("base64");
    try {
      const res = await fetcher(`${base}/users?limit=1`, { headers: { Authorization: auth, Accept: "application/json" } });
      return res.ok
        ? { probeable: true, blocking: true, ok: true, label: "authenticated to Spanning", kind: "live" }
        : { probeable: true, blocking: true, ok: false, error: `Spanning returned ${res.status}`, hint: "check the API user + token and the region", kind: "live" };
    } catch (e) { return { probeable: true, blocking: true, ok: false, error: (e as Error).message, kind: "live" }; }
  },
  // Proofpoint Essentials — X-User/X-Password against /orgs/{domain}. Needs a region (see Task 2);
  // without one we can't build the base URL, so it's advisory (never a false red) — the runner test verifies.
  "proofpoint": async (values, ctx, fetcher) => {
    const user = pickField(values, PROOFPOINT_USER_FIELDS);
    const pass = pickField(values, PROOFPOINT_PASS_FIELDS);
    const domain = pickField(values, PROOFPOINT_DOMAIN_FIELDS) ?? (ctx.clientPrimaryDomain?.trim() || undefined);
    const base = proofpointBase(pickField(values, PROOFPOINT_REGION_FIELDS) ?? "");
    if (!base) return { probeable: false, blocking: false };
    if (!user || !pass) return { probeable: true, blocking: true, ok: false, error: `missing ${!user ? "admin email (X-User)" : "admin password (X-Password)"}`, kind: "live" };
    if (!domain) return { probeable: true, blocking: true, ok: false, error: "no org domain, and the client has no primary domain to fall back on", kind: "live" };
    try {
      const res = await fetcher(`${base}/orgs/${encodeURIComponent(domain)}/settings/azure`, { headers: { "X-User": user, "X-Password": pass } });
      return res.ok
        ? { probeable: true, blocking: true, ok: true, label: "authenticated to Proofpoint Essentials", kind: "live" }
        : { probeable: true, blocking: true, ok: false, error: `Proofpoint returned ${res.status}`, hint: "check the admin email/password, the org domain, and the region", kind: "live" };
    } catch (e) { return { probeable: true, blocking: true, ok: false, error: (e as Error).message, kind: "live" }; }
  },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node node_modules/.bin/tsx --test lib/secrets/value-probe.test.ts`
Expected: PASS (all, including the new ones).

- [ ] **Step 5: Typecheck + commit**

```bash
node node_modules/typescript/bin/tsc --noEmit
git add web/lib/secrets/value-probe.ts web/lib/secrets/value-probe.test.ts
git commit -m "value-probe: live connect checks for mimecast/spanning/proofpoint"
```

---

### Task 2: Proofpoint region field (Option A — store it) + runner read

**Files:**
- Modify: `web/lib/secrets/field-requirements.ts:128-132` (proofpoint entry — add a `region` field)
- Modify: `web/lib/secrets/delinea-templates.ts` (ensure `proofpoint` template name mapped in `DEFAULT_TEMPLATE_NAMES`)
- Modify: `runner/Start-IamRunner.ps1` (Proofpoint conn-test/job: read the region field, pass to `Connect-CtgProofpoint -Region`)
- Modify: `runner/VERSION` (bump minor)
- Test: `web/lib/secrets/field-requirements.test.ts` (if present) or `web/lib/secrets/value-probe.test.ts` already covers the probe reading `Region`.

**Interfaces:**
- Consumes: `SECRET_FIELD_REQUIREMENTS.proofpoint` (existing), the runner's `Connect-CtgProofpoint -Region` (exists, `$script:PpRegions` map).
- Produces: a `proofpoint` credential that carries a `Region` field, read by both the app probe (Task 1) and the runner.

- [ ] **Step 1: Add the region field to field-requirements**

In `web/lib/secrets/field-requirements.ts`, in the `proofpoint` array, add:

```ts
    { label: "region", anyOf: ["Region", "apiURL", "ApiUrl", "BaseUrl", "Base URL", "Url", "URL"], hint: "the Proofpoint Essentials data region: us1..us5, eu1, or au1 (from your console URL)" },
```

- [ ] **Step 2: Read how the runner resolves the Proofpoint region today**

Run: `grep -nE "Connect-CtgProofpoint|Region|X-User|proofpoint" runner/Start-IamRunner.ps1` and read the proofpoint conn-test + job dispatch. Confirm where `-Region` is (or isn't) passed.

- [ ] **Step 3: Pass the secret's region field to Connect-CtgProofpoint**

In the runner's proofpoint dispatch/conn-test, resolve the region from the secret's fields (fall back to the module default `us1`) and pass it, e.g.:

```powershell
$ppRegion = Get-CtgSecretField $creds @('Region','apiURL','ApiUrl','BaseUrl','Url','URL')
Connect-CtgProofpoint -User $ppUser -Password $ppPass -Domain $ppDomain @(if ($ppRegion) { @{ Region = $ppRegion } } else { @{} })
```

(Match the exact call sites/helpers already in the file — `Get-CtgProp`/the secret-field accessor the module uses. This is the one runner touch.)

- [ ] **Step 4: Bump the runner version + parse-check**

```bash
# runner/VERSION: bump the minor (e.g. 1.79.0 -> 1.80.0)
~/.local/pwsh/pwsh -NoProfile -Command "\$t=\$null;\$e=\$null;[System.Management.Automation.Language.Parser]::ParseFile('$PWD/runner/Start-IamRunner.ps1',[ref]\$t,[ref]\$e)|Out-Null; \$e.Count"
```
Expected: `0` parse errors.

- [ ] **Step 5: Typecheck + commit**

```bash
cd web && node node_modules/typescript/bin/tsc --noEmit && cd ..
git add web/lib/secrets/field-requirements.ts web/lib/secrets/delinea-templates.ts runner/Start-IamRunner.ps1 runner/VERSION
git commit -m "proofpoint: a region field on the secret, read by the app probe + runner"
```

---

### Task 3: Per-system API-setup catalog

**Files:**
- Create: `web/lib/secrets/api-setup-catalog.ts`
- Test: `web/lib/secrets/api-setup-catalog.test.ts`

**Interfaces:**
- Consumes: `SECRET_FIELD_REQUIREMENTS` (to derive the input fields per entry).
- Produces: `type ApiSetupEntry`, `API_SETUP_CATALOG: ApiSetupEntry[]`, `apiSetupFor(systemKey: string): ApiSetupEntry | undefined`. Fields: `systemKey`, `secretName`, `label`, `consoleUrl`, `steps: string[]`, `regionOptions?: string[]`.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { API_SETUP_CATALOG, apiSetupFor } from "./api-setup-catalog";
import { SECRET_FIELD_REQUIREMENTS } from "./field-requirements";

test("catalog has mimecast, spanning, proofpoint, each with a real field-requirements secret", () => {
  const keys = API_SETUP_CATALOG.map((e) => e.systemKey).sort();
  assert.deepEqual(keys, ["mimecast", "proofpoint", "spanning"]);
  for (const e of API_SETUP_CATALOG) {
    assert.ok(SECRET_FIELD_REQUIREMENTS[e.secretName], `${e.secretName} must be a known secret`);
    assert.ok(e.label && e.consoleUrl.startsWith("https://") && e.steps.length > 0);
  }
});
test("proofpoint entry offers region options", () => {
  assert.ok((apiSetupFor("proofpoint")?.regionOptions ?? []).includes("us1"));
});
test("apiSetupFor returns undefined for an unknown system", () => {
  assert.equal(apiSetupFor("google"), undefined);
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `node node_modules/.bin/tsx --test lib/secrets/api-setup-catalog.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Write the catalog**

```ts
// Per-system config for the guided "Setup <system> API" flow. One entry = one menu item + its modal
// instructions. Input fields come from SECRET_FIELD_REQUIREMENTS[secretName].
export type ApiSetupEntry = {
  systemKey: string;      // gates the menu item on the client having this system
  secretName: string;     // the Delinea secret to create/verify/wire
  label: string;          // "Mimecast" -> "Setup Mimecast API"
  consoleUrl: string;     // "Open console ↗"
  steps: string[];        // vendor instructions
  regionOptions?: string[]; // Proofpoint: the region picker
};

export const API_SETUP_CATALOG: ApiSetupEntry[] = [
  {
    systemKey: "mimecast", secretName: "mimecast", label: "Mimecast",
    consoleUrl: "https://login.services.mimecast.com/",
    steps: [
      "In the Mimecast Administration Console, go to Services → API and Platform Integrations.",
      "Create a new 2.0 application; copy its Client ID and Client Secret (the secret is shown once).",
      "Paste them below (or the Delinea id you saved them in), then Verify & save.",
    ],
  },
  {
    systemKey: "spanning", secretName: "spanning", label: "Spanning",
    consoleUrl: "https://o365.spanningbackup.com/",
    steps: [
      "In the Spanning admin console, open Settings → API Token.",
      "Generate / copy the API token and note the account/domain and your data region.",
      "Paste them below (or the Delinea id you saved them in), then Verify & save.",
    ],
  },
  {
    systemKey: "proofpoint", secretName: "proofpoint", label: "Proofpoint",
    consoleUrl: "https://us1.proofpointessentials.com/",
    steps: [
      "Use a Proofpoint Essentials admin login that has API access enabled for the org.",
      "Note the org's primary domain and your data region (from the console URL: us1..us5, eu1, au1).",
      "Enter the admin email/password + region below (or the Delinea id), then Verify & save.",
    ],
    regionOptions: ["us1", "us2", "us3", "us4", "us5", "eu1", "au1"],
  },
];

export function apiSetupFor(systemKey: string): ApiSetupEntry | undefined {
  return API_SETUP_CATALOG.find((e) => e.systemKey === systemKey);
}
```

- [ ] **Step 4: Run to verify it passes** — Expected: PASS.
- [ ] **Step 5: Typecheck + commit** — `git commit -m "api-setup-catalog: mimecast/spanning/proofpoint guided-setup config"`

---

### Task 4: Existing-id verify-then-wire (extend the test route)

**Files:**
- Modify: `web/app/api/clients/[slug]/secrets/test/route.ts`
- Test: `web/lib/secrets/<the route's testable core>` — extract the verify-then-wire logic into a pure helper `lib/secrets/verify-and-wire.ts` and unit-test that (routes aren't directly unit-tested here).

**Interfaces:**
- Consumes: `resolveSecretFields` (delinea.ts), `probeSecretValues` (value-probe), `makeClientRepository(db).upsertSecrets`.
- Produces: `verifyAndWire({ db, slug, clientId, name, externalId, label, env, fetcher, ctx }): Promise<{ ok: boolean; error?: string; wired?: boolean }>` — resolves the secret's field values, runs the value-probe, and on a passing (or non-blocking) probe wires the id with the label; a blocking-probe failure refuses to wire.
- The route adds an optional `wireOnPass: boolean` to its request body; when true and the probe passes, it calls `verifyAndWire`.

- [ ] **Step 1: Write the failing test** for `lib/secrets/verify-and-wire.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyAndWire } from "./verify-and-wire";

function fakeDb(existingFields: Record<string, string>) {
  const calls: { upsert: unknown[] } = { upsert: [] };
  const db = {
    secret: { findMany: async () => [], upsert: async (a: unknown) => { calls.upsert.push(a); return {}; } },
    clientSystem: { findMany: async () => [] }, systemSetupState: { updateMany: async () => {} },
    auditLog: { create: async () => {} }, $transaction: async (o: Promise<unknown>[]) => Promise.all(o),
    client: { update: async () => {} },
  } as never;
  return { db, calls };
}
// resolveSecretFields is injected for the test.
test("verifyAndWire: passing probe -> wires the id + label", async () => {
  const { db, calls } = fakeDb({ ClientId: "cid", ClientSecret: "sec" });
  const r = await verifyAndWire({
    db, slug: "acme", clientId: "c1", name: "mimecast", externalId: "12345", label: "Mimecast (auto)",
    env: { DELINEA_BASE_URL: "https://x", DELINEA_USER: "u", DELINEA_PASSWORD: "p" },
    resolveFields: async () => ({ ok: true, fields: { ClientId: "cid", ClientSecret: "sec" } }),
    fetcher: (async () => ({ ok: true, status: 200, json: async () => ({ access_token: "t" }) })) as never,
  });
  assert.equal(r.ok, true); assert.equal(r.wired, true); assert.equal(calls.upsert.length, 1);
});
test("verifyAndWire: failing blocking probe -> does NOT wire", async () => {
  const { db, calls } = fakeDb({});
  const r = await verifyAndWire({
    db, slug: "acme", clientId: "c1", name: "mimecast", externalId: "12345",
    env: { DELINEA_BASE_URL: "https://x", DELINEA_USER: "u", DELINEA_PASSWORD: "p" },
    resolveFields: async () => ({ ok: true, fields: { ClientId: "cid", ClientSecret: "bad" } }),
    fetcher: (async () => ({ ok: false, status: 401, json: async () => ({ error: "invalid_client" }) })) as never,
  });
  assert.equal(r.ok, false); assert.equal(calls.upsert.length, 0);
});
test("verifyAndWire: can't resolve the secret -> error, no wire", async () => {
  const { db, calls } = fakeDb({});
  const r = await verifyAndWire({
    db, slug: "acme", clientId: "c1", name: "mimecast", externalId: "999",
    env: { DELINEA_BASE_URL: "https://x", DELINEA_USER: "u", DELINEA_PASSWORD: "p" },
    resolveFields: async () => ({ ok: false, error: "not found in Delinea" }),
    fetcher: (async () => ({ ok: true, status: 200, json: async () => ({}) })) as never,
  });
  assert.equal(r.ok, false); assert.match(r.error ?? "", /not found/); assert.equal(calls.upsert.length, 0);
});
```

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL (module missing).

- [ ] **Step 3: Write `lib/secrets/verify-and-wire.ts`**

```ts
import type { PrismaClient } from "@prisma/client";
import { probeSecretValues, type ProbeCtx } from "./value-probe";
import { makeClientRepository } from "@/lib/clients/repository";

type ResolveFields = (externalId: string) => Promise<{ ok: true; fields: Record<string, string> } | { ok: false; error: string }>;

export async function verifyAndWire(input: {
  db: PrismaClient; slug: string; clientId: string; name: string; externalId: string; label?: string;
  env?: Record<string, string | undefined>; ctx?: ProbeCtx; fetcher?: typeof fetch; resolveFields: ResolveFields;
}): Promise<{ ok: boolean; error?: string; wired?: boolean; label?: string }> {
  const resolved = await input.resolveFields(input.externalId);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const probe = await probeSecretValues(input.name, resolved.fields, input.ctx ?? {}, input.fetcher ?? fetch);
  if (probe.probeable && probe.blocking && probe.ok === false) return { ok: false, error: probe.error ?? "the credential did not authenticate" };
  await makeClientRepository(input.db).upsertSecrets(input.clientId, [{ name: input.name, externalId: input.externalId, label: input.label ?? null }]);
  return { ok: true, wired: true, label: probe.label };
}
```

- [ ] **Step 4: Run to verify it passes** — Expected: PASS.

- [ ] **Step 5: Wire it into the route**

In `web/app/api/clients/[slug]/secrets/test/route.ts`, after the existing verify logic, when `body.wireOnPass === true` and the secret authenticated, call `verifyAndWire` (real `resolveSecretFields` from `delinea.ts`, `delineaConfigFromEnv()`, the client's `primaryDomain` as `ctx.clientPrimaryDomain`, and an `(auto)` label). Return `{ wired: true }` on success. Keep the current test behavior when `wireOnPass` is absent.

- [ ] **Step 6: Typecheck + commit** — `git commit -m "secrets: verify-then-wire an existing Delinea id (wireOnPass)"`

---

### Task 5: GuidedApiSetup modal component

**Files:**
- Create: `web/app/clients/_components/guided-api-setup.tsx`

**Interfaces:**
- Consumes: `ApiSetupEntry` (Task 3), `SECRET_FIELD_REQUIREMENTS`, the create route `POST /api/clients/[slug]/secrets/create`, the extended test route (Task 4, `wireOnPass:true`).
- Produces: `export function GuidedApiSetup({ slug, entry, openSignal, hideTrigger }: { slug: string; entry: ApiSetupEntry; openSignal?: number; hideTrigger?: boolean })` — same open-signal contract as `M365SetupButton`.

- [ ] **Step 1: Build the component** (client component; mirror `M365SetupButton`'s dialog + openSignal pattern and the `.m365-setup-dialog`/`.m365-optperm` styles). Two input modes via a toggle:
  - **Paste fields**: one `<input>` per `SECRET_FIELD_REQUIREMENTS[entry.secretName]` (label = the requirement's `label`, placeholder from its `hint`), plus a region `<select>` when `entry.regionOptions`. On "Verify & save": `POST /secrets/create { name: entry.secretName, values, label: "<label> (auto)" }`. On ok → show ✓, `router.refresh()`.
  - **Existing Delinea id**: one `<input>` for the id. On "Verify & save": `POST /secrets/test { secrets: [{ name: entry.secretName, externalId }], wireOnPass: true }`. On ok/wired → ✓, `router.refresh()`.
  - Header shows `entry.steps` + an `<a className="button" href={entry.consoleUrl} target="_blank">Open console ↗</a>`.
  - Show the returned verdict/error text (the create route returns the probe error on a blocking fail; render it).

- [ ] **Step 2: Typecheck** — Run: `node node_modules/typescript/bin/tsc --noEmit` — Expected: clean.
- [ ] **Step 3: Commit** — `git commit -m "GuidedApiSetup: one modal for guided API-credential setup"`

---

### Task 6: Menu integration + conditional visibility + M365 gate

**Files:**
- Modify: `web/app/clients/[slug]/page.tsx` (pass `systemKeys` to the menu)
- Modify: `web/app/clients/_components/client-actions-menu.tsx` (render "Setup <label> API" per catalog system the client has; gate M365)

**Interfaces:**
- Consumes: `API_SETUP_CATALOG`, `apiSetupFor`, `GuidedApiSetup`.
- Produces: menu items shown iff `systemKeys.includes(entry.systemKey)`; the M365 item shown iff `systemKeys` includes `m365`/`entra`/`exchange`.

- [ ] **Step 1:** In `page.tsx`, compute `const systemKeys = client.systems.map((s) => s.systemKey);` and pass `systemKeys={systemKeys}` to `<ClientActionsMenu>`.
- [ ] **Step 2:** In `client-actions-menu.tsx`, accept `systemKeys: string[]`. Gate the existing M365 item: only render it when `systemKeys.some((k) => k === "m365" || k === "entra" || k === "exchange")`. For each `API_SETUP_CATALOG` entry whose `systemKey` is in `systemKeys`, render a menu item `Setup {entry.label} API` that increments a per-entry open-signal; render `<GuidedApiSetup slug={slug} entry={entry} openSignal={sig} hideTrigger />` (mounted, like M365).
- [ ] **Step 3: Typecheck** — clean.
- [ ] **Step 4: Live-verify** (dev server + minted session, per the web-dev-verify recipe): open a client that HAS mimecast → the menu shows "Setup Mimecast API" and not others; open the modal; the paste form renders the mimecast fields. Open a Google-only client → no M365/Mimecast/Spanning/Proofpoint setup items. Screenshot each.
- [ ] **Step 5: Commit** — `git commit -m "client actions: Setup <system> API items (conditional) + gate M365 on m365/entra/exchange"`

---

### Task 7: Changelog + final verification

**Files:**
- Create: `web/lib/changelog/entries/guided-api-setup.ts` (+ register in `_registry.ts`, id-sorted)

- [ ] **Step 1:** Write the changelog entry (what it does / that it's guided verify-then-vault / conditional visibility / the M365 gate). `time` via `TZ=America/New_York date +%H:%M` on a 15-min boundary.
- [ ] **Step 2: Register + validate** — Run: `node node_modules/.bin/tsx --test lib/changelog/entries/registry.test.ts lib/changelog/format.test.ts` — Expected: PASS.
- [ ] **Step 3: Full suite + typecheck** — Run: `node node_modules/.bin/tsx --test "lib/**/*.test.ts"` and `node node_modules/typescript/bin/tsc --noEmit` — Expected: all pass, clean.
- [ ] **Step 4: Commit + open PR** — `git commit -m "changelog: guided API setup for Mimecast/Spanning/Proofpoint"` then push + `gh pr create --draft`.

---

## Self-review notes

- **Spec coverage:** value-probe (§2 → T1), catalog (§1 → T3), verify/vault reuse (§4 → T1 create-route reuse + T4 existing-id), UI modal (§3 → T5), menu + M365 gate + conditional visibility (§3/§5 → T6), Proofpoint region Option A (§2 decision → T2). ✔
- **Placeholder scan:** the route wiring (T4 Step 5) and the modal (T5) describe structure with the exact endpoints/props rather than full JSX — acceptable because they mirror existing components (`create-in-delinea.tsx`, `M365SetupButton`); the executor must read those two files first. The backend tasks (T1/T3/T4 core) have complete code.
- **Type consistency:** `ApiSetupEntry` fields (T3) are consumed unchanged in T5/T6; `verifyAndWire` signature (T4) matches its route call; probe `secretName` keys match catalog `secretName`s and field-requirements keys.
