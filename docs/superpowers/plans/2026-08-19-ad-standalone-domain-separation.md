# AD-standalone domain separation — implementation plan (FR #0000083 + #0000107)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an `ad-standalone` client keep a different domain on-prem from the one it uses for mail
(e.g. AD `syee.local`, mail `olympuscosmetic.com`), and stop injecting the two hybrid-only steps —
`ad-email-writeback` and `ad-consistency-check` — into standalone clients where they are meaningless
or actively wrong.

**Architecture:** One new optional field, `identity.adDomain`. When a client's backbone is
`ad-standalone` **and** that field is set, the on-prem lane's `userPrincipalName` is rewritten to
that domain at dispatch time, reusing the existing per-system payload-override seam in
`runner-service.ts`. Two one-line backbone guards in `orchestrator.ts` stop the hybrid-only synthetic
steps from being planned for standalone clients. **No runner module changes, so no runner deploy.**

**Tech Stack:** Next.js (App Router, TypeScript), Prisma/PostgreSQL, `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-17-open-feature-requests-batch-2-design.md` (revised order, item 1)

## Global Constraints

- **Both requests close on this one work item.** #83 asks for the AD domain; #107 asks for the same
  separation *and* reports the writeback misfiring. One fix, two resolution notes.
- **This change MUST NOT alter behaviour for any client that is not `ad-standalone`.** It is gated on
  backbone in every path. The fleet is 97 `entra`, 42 `ad_synced`, 41 unmodeled, 10 `google` and only
  **3 `ad_standalone`** — an unintended change to the UPN of an `ad_synced` client would mean wrong
  accounts at scale, which is the whole reason this was ranked behind everything else in the original
  spec.
- **For an `ad_synced` client the AD UPN and cloud UPN are the same by definition** — that is what
  syncing means. `adDomain` is therefore honoured for `ad-standalone` only, even if someone sets it on
  a synced client.
- **No runner change and no `runner/VERSION` bump.** The AD module already reads
  `$User.UserPrincipalName` (`Coretelligent.ActiveDirectory.psm1:178`) and
  `UserPrincipalNameFallbacks` (`:188`); we change what it is handed, not how it behaves.
- **Container placement is already correct — do not touch it.** `Resolve-CtgAdDomain`
  (`Coretelligent.ActiveDirectory.psm1:64-71`) deliberately queries the live DC for the DN's domain,
  with a comment about exactly this `corp.example.com` vs mail-domain split. The bug is the UPN
  suffix, not the OU/DN.
- `samAccountName` carries no domain and must not change.
- Test baseline on a branch cut from `origin/main`: **2126 tests, 2120 pass, 6 fail** (the six known
  failures listed in the spec). Runner Pester suites must stay green but need no new tests.

## Background: what is actually broken

**The domain gap.** `web/lib/cases/planning-service.ts:63` resolves exactly one domain —

```ts
let domain = client.emailDomain ?? client.primaryDomain;
```

— and hands it to `deriveIdentity` (`web/lib/servicenow/intake-mapper.ts:342`), which builds
`userPrincipalName` for **every** lane from `{domain}` in `usernamePatterns`. There is no way to
express "AD uses one namespace, mail uses another."

The three `ad_standalone` clients today:

| Client | primaryDomain | emailDomain | AD + cloud lanes | Hybrid steps injected |
|---|---|---|---|---|
| `core2187` Olympus – LittleRock – YEE | drsuzanneyee.com | olympuscosmetic.com | **both** | **yes** |
| `core1559` Hitachi PES | accsys.com | hitachi-pes.com | AD only | no |
| `core1223` Garden Oaks Vet | gardenoaksvet.com | gardenoaksvet.com | neither | no |

**The misfiring steps.** `web/lib/orchestrator.ts:143` injects `ad-email-writeback` whenever
`active-directory` **and** (`m365` or `exchange`) are active, with no backbone check; `:164` does the
same for `ad-consistency-check`. Both exist for *hybrid* identity (one person, one account, synced).
On a standalone client the AD and cloud accounts are separate identities on purpose, so:

- the writeback stamps the **cloud** mailbox address into on-prem `mail` — #107's report;
- the consistency check compares the AD anchor to an Entra object that is deliberately unrelated, so
  it can only ever report a mismatch, training operators to ignore a warning that matters elsewhere.

Today that affects exactly one client (`core2187`), which is also #83's client.

## File structure

- **Modify** `profiles/_schema.json` — add `identity.adDomain` (optional string).
- **Create** `web/lib/profiles/ad-domain.ts` — the pure resolver (`adUpnFor`). New file because it is
  a self-contained decision with one input shape and one output, and it is consumed by both a dispatch
  path and (for display) the job request.
- **Create** `web/lib/profiles/ad-domain.test.ts`
- **Modify** `web/lib/orchestrator.ts:143,164` — backbone guards on the two synthetic steps.
- **Modify** `web/lib/jobs/runner-service.ts` — per-system payload override for on-prem AD systems.
- **Modify** `web/app/api/clients/[slug]/route.ts` — accept `adDomain` on PATCH.
- **Modify** `web/app/clients/[slug]/page.tsx` — surface the field.
- **Create** `web/lib/changelog/entries/ad-standalone-domain-separation.ts` + one line in `_registry.ts`.

---

### Task 1: `identity.adDomain` in the profile schema

**Files:**
- Modify: `profiles/_schema.json` (the `identity` block — it already has `backbone`,
  `usernamePatterns`, `lowercase`, `domainRules`, `password`)
- Test: whichever test validates profiles against the schema — find it with
  `grep -rln "_schema.json" web/lib web/scripts profiles`

**Interfaces:**
- Consumes: nothing
- Produces: `identity.adDomain?: string` — read by Task 2 as
  `(client.identity as { adDomain?: string }).adDomain`

`identity` is a `Json` column on `Client`, so **there is no Prisma migration.** `identity.domainRules`
is the existing precedent for domain routing living in this block.

- [ ] **Step 1: Write the failing test**

Add to the profile-schema test file:

```ts
test("identity.adDomain is an accepted optional string", () => {
  const schema = JSON.parse(readFileSync(resolve(ROOT, "profiles/_schema.json"), "utf8"));
  const identity = schema.properties?.identity ?? schema.$defs?.identity;
  assert.ok(identity, "the schema has an identity block");
  assert.ok(identity.properties.adDomain, "identity.adDomain is declared");
  assert.equal(identity.properties.adDomain.type, "string");
  // It must stay OPTIONAL — every existing profile omits it.
  assert.ok(!(identity.required ?? []).includes("adDomain"), "adDomain is not required");
  // additionalProperties is false on this block, so an undeclared key would be rejected.
  assert.equal(identity.additionalProperties, false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd web && npx tsx --test <the schema test file>`
Expected: FAIL — `identity.adDomain is declared` (the key does not exist yet).

- [ ] **Step 3: Add the field**

In `profiles/_schema.json`, inside `identity.properties`, after `domainRules`:

```json
    "adDomain": {
      "type": "string",
      "description": "AD-STANDALONE ONLY: the on-prem AD DNS namespace / UPN suffix, when it differs from the mail domain (e.g. AD syee.local, mail olympuscosmetic.com). Sets the userPrincipalName the on-prem lane is handed; the cloud lane keeps emailDomain. Ignored unless backbone is ad-standalone — on an ad-synced client the two are the same by definition. Container/DN placement is NOT affected: the AD module resolves that live from the domain controller (Resolve-CtgAdDomain)."
    },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && npx tsx --test <the schema test file>`
Expected: PASS. Then `cd web && npm test` — every existing profile must still validate, since the
field is optional.

- [ ] **Step 5: Commit**

```bash
git add profiles/_schema.json web/lib/<the schema test file>
git commit -m "Profile schema: identity.adDomain for AD-standalone clients

An ad-standalone client can have an on-prem namespace that differs from its
mail domain. identity is a Json column, so no migration."
```

---

### Task 2: The pure resolver

**Files:**
- Create: `web/lib/profiles/ad-domain.ts`
- Test: `web/lib/profiles/ad-domain.test.ts`

**Interfaces:**
- Consumes: `deriveIdentity` from `web/lib/servicenow/intake-mapper.ts` (exported, line 342), whose
  signature is `deriveIdentity(payload, { usernamePatterns?: string[] | null; primaryDomain?: string | null })`
- Produces:
  `adUpnFor(payload: Record<string, unknown>, client: { backbone?: string | null; identity?: unknown }): { upn: string; fallbacks: string[] } | null`
  — `null` means "change nothing", which is the answer for every client except a standalone one with
  `adDomain` set.

- [ ] **Step 1: Write the failing tests**

Create `web/lib/profiles/ad-domain.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { adUpnFor } from "./ad-domain";

const payload = { firstName: "Suzanne", lastName: "Yee" };
const identity = { usernamePatterns: ["{firstinitial}{last}@{domain}"], adDomain: "syee.local" };

test("rewrites the UPN to the AD domain for an ad-standalone client", () => {
  const r = adUpnFor({ ...payload, userPrincipalName: "syee@olympuscosmetic.com" },
    { backbone: "ad_standalone", identity });
  assert.ok(r);
  assert.equal(r.upn, "syee@syee.local");
});

test("returns null for an ad_synced client even when adDomain is set", () => {
  // On a synced client the AD UPN and the cloud UPN are the SAME by definition — rewriting one
  // would break the hard-match the sync depends on.
  assert.equal(adUpnFor(payload, { backbone: "ad_synced", identity }), null);
});

test("returns null for entra and google clients", () => {
  for (const backbone of ["entra", "google", null, undefined]) {
    assert.equal(adUpnFor(payload, { backbone: backbone as string | null, identity }), null, `backbone ${backbone}`);
  }
});

test("returns null for a standalone client with no adDomain configured", () => {
  assert.equal(adUpnFor(payload, { backbone: "ad_standalone", identity: { usernamePatterns: ["{first}.{last}@{domain}"] } }), null);
});

test("returns null when adDomain is blank or whitespace", () => {
  for (const adDomain of ["", "   "]) {
    assert.equal(adUpnFor(payload, { backbone: "ad_standalone", identity: { usernamePatterns: ["{first}.{last}@{domain}"], adDomain } }), null);
  }
});

test("accepts the hyphenated schema spelling of the backbone", () => {
  // profiles/_schema.json writes "ad-standalone"; the Prisma enum is "ad_standalone".
  const r = adUpnFor(payload, { backbone: "ad-standalone", identity });
  assert.ok(r);
  assert.equal(r.upn, "syee@syee.local");
});

test("carries the conflict fallbacks onto the AD domain too", () => {
  const r = adUpnFor(payload, {
    backbone: "ad_standalone",
    identity: { usernamePatterns: ["{first}.{last}@{domain}", "{first}.{mi}@{domain}"], adDomain: "syee.local" },
  });
  assert.ok(r);
  assert.equal(r.upn, "suzanne.yee@syee.local");
  for (const f of r.fallbacks) assert.ok(f.endsWith("@syee.local"), `fallback ${f} is on the AD domain`);
});

test("the mail-domain payload is left untouched (pure)", () => {
  const p = { ...payload, userPrincipalName: "syee@olympuscosmetic.com" };
  const before = JSON.stringify(p);
  adUpnFor(p, { backbone: "ad_standalone", identity });
  assert.equal(JSON.stringify(p), before, "adUpnFor must not mutate its input");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd web && npx tsx --test lib/profiles/ad-domain.test.ts`
Expected: FAIL — cannot resolve `./ad-domain`.

- [ ] **Step 3: Write the implementation**

Create `web/lib/profiles/ad-domain.ts`:

```ts
// AD-STANDALONE domain separation (FR #83 / #107).
//
// An ad-standalone client runs on-prem AD and a SEPARATE, unsynced M365/Entra — two accounts for one
// person, managed independently. Such a client can have an on-prem namespace that is not its mail
// domain (Olympus - LittleRock - YEE: AD syee.local, mail olympuscosmetic.com), and until now there
// was no way to say so: planning-service resolves ONE domain (emailDomain ?? primaryDomain) and
// deriveIdentity builds the UPN for every lane from it.
//
// This returns the userPrincipalName the ON-PREM lane should be handed, or null for "change nothing".
//
// Null is the answer for everything except a standalone client with adDomain set — deliberately:
//   - ad_synced: the AD UPN and the cloud UPN are the SAME by definition (that is what syncing
//     means). Rewriting one would break the hard-match AD Connect relies on, across 42 clients.
//   - entra / google / unmodeled: there is no on-prem lane to give a different UPN to.
// The container/DN is NOT our business — the AD module resolves that live from the domain controller
// (Resolve-CtgAdDomain), which already handles the corp-vs-mail-domain split correctly.
import { deriveIdentity } from "../servicenow/intake-mapper";

// The profile schema spells it "ad-standalone"; the Prisma enum is "ad_standalone". Accept both so a
// profile-sourced value and a database-sourced value behave identically.
const STANDALONE = new Set(["ad_standalone", "ad-standalone"]);

export function adUpnFor(
  payload: Record<string, unknown>,
  client: { backbone?: string | null; identity?: unknown }
): { upn: string; fallbacks: string[] } | null {
  if (!STANDALONE.has(String(client.backbone ?? ""))) return null;
  const identity = (client.identity ?? {}) as { usernamePatterns?: string[] | null; adDomain?: unknown };
  const adDomain = typeof identity.adDomain === "string" ? identity.adDomain.trim() : "";
  if (!adDomain) return null;

  // Re-derive with the AD domain substituted for the mail domain, reusing the SAME pattern engine
  // that produced the cloud UPN — so tokens, the nickname rule, and the conflict fallbacks all behave
  // identically and cannot drift from the cloud lane's derivation.
  const derived = deriveIdentity({ ...payload }, {
    usernamePatterns: identity.usernamePatterns ?? null,
    primaryDomain: adDomain,
  });
  const upn = typeof derived.userPrincipalName === "string" ? derived.userPrincipalName : "";
  if (!upn) return null;
  const fallbacks = Array.isArray(derived.userPrincipalNameFallbacks)
    ? (derived.userPrincipalNameFallbacks as unknown[]).filter((f): f is string => typeof f === "string")
    : [];
  return { upn, fallbacks };
}
```

The key name is verified: `deriveIdentity` returns `userPrincipalNameFallbacks`
(`web/lib/servicenow/intake-mapper.ts:402`), which is the camelCase counterpart of the
`UserPrincipalNameFallbacks` the AD module reads at `Coretelligent.ActiveDirectory.psm1:188`.

- [ ] **Step 4: Run to verify they pass**

Run: `cd web && npx tsx --test lib/profiles/ad-domain.test.ts`
Expected: PASS, all eight.

- [ ] **Step 5: Commit**

```bash
git add web/lib/profiles/ad-domain.ts web/lib/profiles/ad-domain.test.ts
git commit -m "FR #83/#107: resolve the on-prem UPN for an ad-standalone client

Pure: returns the AD-domain userPrincipalName, or null meaning change nothing.
Null for ad_synced on purpose — there the AD and cloud UPN are the same by
definition and rewriting one would break the hard-match, across 42 clients."
```

---

### Task 3: Hand the AD lane its own UPN at dispatch

**Files:**
- Modify: `web/lib/jobs/runner-service.ts` — the per-system payload override chain (search for
  `j.systemKey === "ad-email-writeback"`, currently around line 1294)
- Test: `web/lib/jobs/` — add to an existing runner-service test file, or create
  `web/lib/jobs/ad-standalone-upn.test.ts`

**Interfaces:**
- Consumes: `adUpnFor` (Task 2)
- Produces: nothing new; it changes the `userPrincipalName` in the payload handed to on-prem AD jobs

This is the established seam. That chain already swaps in `writebackEmail` for `ad-email-writeback`
and `cloudObject` for `ad-consistency-check`; an AD-lane UPN override belongs beside them. Because it
happens here, **no runner module changes** — the AD module keeps reading `$User.UserPrincipalName`.

The on-prem systems are already enumerated as `ALWAYS_ON_PREM_SYSTEMS` in
`web/lib/cases/case-secrets.ts:29`: `["active-directory", "directory-sync", "ad-email-writeback",
"ad-consistency-check", "ad-hard-match", "ad-password-reset"]`. Import that rather than re-listing
them — a new on-prem step added later must inherit this automatically.

- [ ] **Step 1: Write the failing tests**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { adUpnFor } from "../profiles/ad-domain";
import { ALWAYS_ON_PREM_SYSTEMS } from "../cases/case-secrets";

// The override applied at dispatch, extracted so it is testable without a database.
// (If the implementation inlines it, export a named helper and import that instead.)
import { applyAdStandaloneUpn } from "./ad-standalone-upn";

const client = {
  backbone: "ad_standalone",
  identity: { usernamePatterns: ["{firstinitial}{last}@{domain}"], adDomain: "syee.local" },
};
const payload = { firstName: "Suzanne", lastName: "Yee", userPrincipalName: "syee@olympuscosmetic.com" };

test("every on-prem AD system gets the AD-domain UPN", () => {
  for (const systemKey of ALWAYS_ON_PREM_SYSTEMS) {
    const out = applyAdStandaloneUpn(payload, systemKey, client);
    assert.equal(out.userPrincipalName, "syee@syee.local", `${systemKey} got the AD UPN`);
  }
});

test("cloud lanes keep the mail-domain UPN", () => {
  for (const systemKey of ["m365", "entra", "exchange", "mimecast"]) {
    const out = applyAdStandaloneUpn(payload, systemKey, client);
    assert.equal(out.userPrincipalName, "syee@olympuscosmetic.com", `${systemKey} kept the mail UPN`);
  }
});

test("an ad_synced client is untouched on every lane", () => {
  const synced = { backbone: "ad_synced", identity: client.identity };
  for (const systemKey of [...ALWAYS_ON_PREM_SYSTEMS, "m365", "entra"]) {
    const out = applyAdStandaloneUpn(payload, systemKey, synced);
    assert.equal(out.userPrincipalName, "syee@olympuscosmetic.com", `${systemKey} unchanged`);
  }
});

test("a standalone client with no adDomain is untouched", () => {
  const out = applyAdStandaloneUpn(payload, "active-directory",
    { backbone: "ad_standalone", identity: { usernamePatterns: ["{first}.{last}@{domain}"] } });
  assert.equal(out.userPrincipalName, "syee@olympuscosmetic.com");
});

test("the original payload is not mutated", () => {
  const before = JSON.stringify(payload);
  applyAdStandaloneUpn(payload, "active-directory", client);
  assert.equal(JSON.stringify(payload), before);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd web && npx tsx --test lib/jobs/ad-standalone-upn.test.ts`
Expected: FAIL — cannot resolve `./ad-standalone-upn`.

- [ ] **Step 3: Write the implementation**

Create `web/lib/jobs/ad-standalone-upn.ts`:

```ts
// Hand the ON-PREM lane of an ad-standalone client its own userPrincipalName (FR #83 / #107).
//
// Applied at dispatch, alongside the writebackEmail and cloudObject overrides, so the AD module needs
// no change at all — it keeps reading $User.UserPrincipalName and simply receives the right value.
// A no-op for every client except a standalone one with identity.adDomain set (see adUpnFor).
import { adUpnFor } from "../profiles/ad-domain";
import { ALWAYS_ON_PREM_SYSTEMS } from "../cases/case-secrets";

export function applyAdStandaloneUpn(
  payload: Record<string, unknown>,
  systemKey: string,
  client: { backbone?: string | null; identity?: unknown } | null | undefined
): Record<string, unknown> {
  if (!client || !ALWAYS_ON_PREM_SYSTEMS.includes(systemKey)) return payload;
  const ad = adUpnFor(payload, client);
  if (!ad) return payload;
  return { ...payload, userPrincipalName: ad.upn, userPrincipalNameFallbacks: ad.fallbacks };
}
```

Then wire it into `runner-service.ts`. The claim path already loads `caseMeta` with each case's
client; extend that `select` to include `backbone` and `identity`, build a
`Map<caseRequestId, {backbone, identity}>`, and wrap the payload in the existing per-system override
chain so the AD override composes with (does not replace) the `writebackEmail` / `cloudObject`
branches.

> **Implementer note:** read the override chain around `runner-service.ts:1290-1300` first. The
> existing branches are mutually exclusive `? :` arms; the AD-UPN override must apply to
> `ad-email-writeback` and `ad-consistency-check` **as well as** their existing overrides, so it has
> to wrap the result of that chain rather than become another arm of it. Do not restructure the chain
> beyond what that requires.

- [ ] **Step 4: Run the tests**

Run: `cd web && npx tsx --test lib/jobs/ad-standalone-upn.test.ts` — expected PASS.
Then `cd web && npm test` — expected **2126 / 2120 pass / 6 fail**, plus your new tests, and no
seventh failure. Every existing runner-service test must be untouched.

- [ ] **Step 5: Commit**

```bash
git add web/lib/jobs/ad-standalone-upn.ts web/lib/jobs/ad-standalone-upn.test.ts web/lib/jobs/runner-service.ts
git commit -m "FR #83/#107: the on-prem lane gets the AD-domain UPN at dispatch

Applied beside the existing writebackEmail / cloudObject overrides, so the AD
module needs no change and no runner deploy. Gated on ALWAYS_ON_PREM_SYSTEMS so
a future on-prem step inherits it, and a no-op for every non-standalone client."
```

---

### Task 4: Stop planning the hybrid-only steps for standalone clients

**Files:**
- Modify: `web/lib/orchestrator.ts:143` (`ad-email-writeback`) and `:164` (`ad-consistency-check`)
- Test: `web/lib/orchestrator.test.ts` (which already has
  `"AD onboard injects ad-email-writeback after the cloud steps"` at line 154 — that test is the
  regression guard for `ad_synced` and must keep passing)

**Interfaces:**
- Consumes: the client's backbone, which `planCase` must be able to see at the injection point
- Produces: plans without those two steps for standalone clients

- [ ] **Step 1: Write the failing tests**

Add to `web/lib/orchestrator.test.ts`, mirroring the setup of the existing injection test:

```ts
test("ad-standalone onboard does NOT inject ad-email-writeback", () => {
  // Standalone means AD and 365 are separate accounts on purpose, so stamping the CLOUD mailbox
  // address into on-prem `mail` is wrong (FR #107).
  const keys = planKeysFor({ backbone: "ad_standalone", systems: ["active-directory", "m365"], action: "onboard" });
  assert.ok(!keys.includes("ad-email-writeback"), keys.join(","));
});

test("ad-standalone onboard does NOT inject ad-consistency-check", () => {
  // The check compares the AD source anchor to an Entra object that is deliberately unrelated here,
  // so it can only ever report a mismatch.
  const keys = planKeysFor({ backbone: "ad_standalone", systems: ["active-directory", "m365"], action: "onboard" });
  assert.ok(!keys.includes("ad-consistency-check"), keys.join(","));
});

test("ad_synced onboard STILL injects both (regression guard)", () => {
  const keys = planKeysFor({ backbone: "ad_synced", systems: ["active-directory", "m365"], action: "onboard" });
  assert.ok(keys.includes("ad-email-writeback"), keys.join(","));
  assert.ok(keys.includes("ad-consistency-check"), keys.join(","));
});
```

> **Implementer note:** `planKeysFor` is shorthand — build the arguments the way the existing tests in
> this file do (read `orchestrator.test.ts:154` and the helpers above it) and follow that shape
> exactly. If `planCase` does not currently receive the backbone at all, that is part of this task:
> thread it in the same way `personaSystems` / `skipSystems` are threaded, and say so in your report.

- [ ] **Step 2: Run to verify they fail**

Run: `cd web && npx tsx --test lib/orchestrator.test.ts`
Expected: FAIL on the two standalone tests (both steps are currently injected); the `ad_synced`
regression guard should PASS already.

- [ ] **Step 3: Write the implementation**

Guard both injections. At `orchestrator.ts:143`:

```ts
  // NOT for ad-standalone: there, AD and the cloud are two separate accounts for one person, managed
  // independently — so writing the CLOUD mailbox address into on-prem `mail` is wrong, not helpful
  // (FR #107). Hybrid (ad_synced) is the case this step exists for.
  if (action === "onboard" && !isAdStandalone && activeKeys.has("active-directory") && (activeKeys.has("m365") || activeKeys.has("exchange")) && !activeKeys.has("ad-email-writeback")) {
```

and at `:164`:

```ts
  // NOT for ad-standalone: the on-prem object is not supposed to link to the cloud one, so an anchor
  // comparison can only ever report a mismatch — noise that trains operators to ignore the warning
  // where it does matter (FR #107).
  if (action === "onboard" && !isAdStandalone && activeKeys.has("active-directory") && (activeKeys.has("m365") || activeKeys.has("entra")) && !activeKeys.has("ad-consistency-check")) {
```

with, above both, a single definition using the same both-spellings rule as Task 2:

```ts
  const isAdStandalone = ["ad_standalone", "ad-standalone"].includes(String(backbone ?? ""));
```

- [ ] **Step 4: Run the tests**

Run: `cd web && npx tsx --test lib/orchestrator.test.ts` — the two new standalone tests PASS and the
existing `"AD onboard injects ad-email-writeback after the cloud steps"` still PASSES.
Then `cd web && npm test` — 2126 / 2120 pass / 6 fail plus the new tests.

- [ ] **Step 5: Commit**

```bash
git add web/lib/orchestrator.ts web/lib/orchestrator.test.ts
git commit -m "FR #107: don't plan the hybrid-only AD steps for ad-standalone clients

ad-email-writeback stamped the CLOUD mailbox address into on-prem mail, and
ad-consistency-check compared anchors that are unrelated by design. Both were
injected on an AD+cloud condition with no backbone check. Hybrid clients are
unchanged, with a regression guard."
```

---

### Task 5: Let an operator set the AD domain

**Files:**
- Modify: `web/app/api/clients/[slug]/route.ts` — accept `adDomain` on PATCH (it already handles
  `emailDomain`; see the audit detail at line 181 for the existing pattern)
- Modify: `web/app/clients/[slug]/page.tsx` — show the field near the email-domains area
- Test: add to the existing route test if there is one; otherwise assert the validation helper

#83's exact words are "there's no way to specify that", so the field has to be settable without
editing a profile by hand.

- [ ] **Step 1: Write the failing test**

```ts
test("PATCH accepts adDomain and stores it on identity", async () => {
  // adDomain lives inside the identity Json blob, so the route must MERGE it rather than replace
  // identity and lose usernamePatterns.
  const before = { usernamePatterns: ["{firstinitial}{last}@{domain}"], password: { mode: "generated" } };
  const merged = mergeAdDomain(before, "syee.local");
  assert.deepEqual(merged.usernamePatterns, before.usernamePatterns);
  assert.deepEqual(merged.password, before.password);
  assert.equal(merged.adDomain, "syee.local");
});

test("a blank adDomain clears the field rather than storing an empty string", () => {
  const merged = mergeAdDomain({ usernamePatterns: ["x"], adDomain: "syee.local" }, "  ");
  assert.equal(merged.adDomain, undefined);
});

test("adDomain is rejected if it isn't a plausible DNS name", () => {
  for (const bad of ["not a domain", "syee.local/x", "http://syee.local"]) {
    assert.throws(() => mergeAdDomain({ usernamePatterns: ["x"] }, bad), /domain/i, bad);
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npx tsx --test <the route/helper test file>`
Expected: FAIL — `mergeAdDomain` does not exist.

- [ ] **Step 3: Write the implementation**

Add a small exported `mergeAdDomain(identity, value)` helper beside the route (or in
`web/lib/profiles/ad-domain.ts` next to `adUpnFor`, which keeps the concept in one file) that:
merges into the existing identity object without dropping other keys; trims; deletes the key on
blank; and validates the shape with a DNS-label regex such as
`/^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i`
(a `.local` namespace must pass). Wire it into the PATCH handler, audited the same way the
`emailDomain` change is at line 181.

Then surface it on `web/app/clients/[slug]/page.tsx`: a single text input labelled
**"AD domain (standalone only)"** with helper text *"Set this only when on-prem AD uses a different
namespace from email — e.g. AD `syee.local`, mail `olympuscosmetic.com`. Leave blank otherwise."*
Follow the page's existing field patterns; per `CLAUDE.md`, keep it plain — flat, minimal borders,
sentence case.

- [ ] **Step 4: Run the tests**

Run: `cd web && npm test` — expected 2126 / 2120 pass / 6 fail plus the new tests. Then
`cd web && npx tsc --noEmit` for the page change.

- [ ] **Step 5: Commit**

```bash
git add web/app/api/clients/\[slug\]/route.ts web/app/clients/\[slug\]/page.tsx web/lib/profiles/ad-domain.ts web/lib/profiles/ad-domain.test.ts
git commit -m "FR #83: set the AD domain from the client page

Merged into the identity blob rather than replacing it, validated as a DNS name
(.local included), audited like the emailDomain change, and cleared on blank."
```

---

### Task 6: Changelog, and close both requests

**Files:**
- Create: `web/lib/changelog/entries/ad-standalone-domain-separation.ts`
- Modify: `web/lib/changelog/entries/_registry.ts` (one id-ordered line)

**No `runner/VERSION` bump** — no runner module changed. State that explicitly in the PR.

- [ ] **Step 1: Write the changelog entry**

```ts
import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "ad-standalone-domain-separation",
  date: "2026-08-19",
  time: "12:00",
  title: "AD-standalone clients can use a different domain on-prem from the one they use for email",
  items: [
    "New \"AD domain\" field on a client: when on-prem AD uses a different namespace from email (e.g. AD syee.local, mail olympuscosmetic.com), the on-prem account is now created with the AD domain while 365 keeps the email domain. Previously one domain was used for both and there was no way to separate them",
    "Only applies to AD-standalone clients. On an AD-synced client the two are the same by definition — the account syncs up — so nothing changes there, and nothing changes for cloud-only or Google clients",
    "Where the on-prem account is PLACED is unaffected: that has always been resolved live from the domain controller",
    "Offboarding and password resets on those clients now identify the on-prem user by its AD-domain sign-in name too",
    "AD-standalone onboards no longer run the email write-back step, which was copying the 365 mailbox address into on-prem AD. On a standalone client the two accounts are separate on purpose, so that was wrong",
    "AD-standalone onboards no longer run the AD/Entra consistency check either. It compares the on-prem account to its synced cloud twin — on a standalone client there isn't one, so it could only ever report a mismatch",
    "Closes feature requests #0000083 and #0000107",
  ],
};
```

- [ ] **Step 2: Register it**

Add one line to `_registry.ts` in id order (the file is id-sorted with a `merge=union` driver so
concurrent PRs don't collide):

```ts
export { entry as adStandaloneDomainSeparation } from "./ad-standalone-domain-separation";
```

- [ ] **Step 3: Run both suites**

Run: `cd web && npm test` — **2126 / 2120 pass / 6 fail** plus every test added by Tasks 1-5, and no
seventh failure. `registry.test.ts` passes only if step 2 was done.
Run: `pwsh -NoProfile -Command "Invoke-Pester runner/tests/Coretelligent.ActiveDirectory.Tests.ps1"`
— must be green. No runner file changed, so this is a guard, not a change.

- [ ] **Step 4: Commit and open the PR**

```bash
git add web/lib/changelog/entries/ad-standalone-domain-separation.ts web/lib/changelog/entries/_registry.ts
git commit -m "Changelog for the AD-standalone domain separation"
git push -u origin fr-83-ad-standalone-domains
gh pr create --title "FR #83/#107: AD-standalone clients can separate their AD domain from their mail domain"
```

- [ ] **Step 5: Close both requests (after merge)**

Dry-run each first.

```bash
npx tsx web/scripts/fr-status.ts 83 done --note "..." --dry-run
npx tsx web/scripts/fr-status.ts 107 done --note "..." --dry-run
```

---

## Verification

Unit tests are necessary but not sufficient here — the risk is a UPN change reaching a client it
should not.

1. **Prove the fleet is unaffected.** Before merge, run a read-only script over all 193 clients that
   calls `adUpnFor` with a representative payload and asserts it returns `null` for every client whose
   backbone is not `ad_standalone`, and for the two standalone clients that have no `adDomain` set.
   Expected: **non-null for zero clients today** (none has `adDomain` yet), which proves the change is
   inert until someone sets the field.
2. **Set `adDomain` on `core2187` only** (`syee.local`) and re-run that script: exactly one client
   returns a non-null AD UPN, ending `@syee.local`, and its cloud UPN is still on
   `olympuscosmetic.com`.
3. **Plan a case for `core2187` without running it** — the same pure re-derivation used to diagnose
   #42 (`resolvePlannedConfigs` against the live client, writing nothing) — and confirm the plan
   contains neither `ad-email-writeback` nor `ad-consistency-check`.
4. **Plan a case for an `ad_synced` client** (e.g. `core2030`) the same way and confirm both steps are
   still present and its UPN is unchanged. This is the regression that matters most.
5. **Confirm `core1559`** (Hitachi PES, standalone, AD but no cloud lane) is unaffected either way —
   it has no cloud lane, so neither synthetic step was ever injected.
6. `pwsh -NoProfile -Command "Invoke-Pester runner/tests/Coretelligent.ActiveDirectory.Tests.ps1"`
   green, confirming no runner behaviour moved.
