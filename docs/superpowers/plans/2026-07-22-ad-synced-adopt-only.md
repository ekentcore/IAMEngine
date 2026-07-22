# AD-synced onboard: adopt-only M365/Entra — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For an `ad_synced` client, the `m365`/`entra` onboard step must never create a cloud account — it adopts the AD-synced account or fails clearly — unless cloud-create is explicitly enabled per-client or per-case.

**Architecture:** Policy is decided at plan time in `web/lib/profiles/plan-resolve.ts` (stamps `cloudCreate: 'deny'|'allow'` onto the m365/entra job config, exactly as the rehire flow stamps `usernameCollisionPolicy`), rides in `Job.request.config`, and is enforced by the runner's M365 module at the create gate (`Coretelligent.M365.psm1:771`). On a `deny` with no account found, the runner does a broader synced-user search and either raises a `DECISION_NEEDED:synced_upn_mismatch` (found under a different UPN) or fails cleanly (nothing found) — never `New-MgUser`. Overrides: a persistent `allowCloudCreate` flag on the m365/entra config, and a per-case override written through the existing `/api/cases/[id]/m365-override` route.

**Tech Stack:** PowerShell 7 (runner, Pester tests via `~/.local/pwsh/pwsh`), Next.js/TypeScript + Prisma (web, vitest).

## Global Constraints

- Backbone enum value is `ad_synced` (underscore), from the `Client.backbone` column — NOT the hyphenated profile string `ad-synced`. Compare against `"ad_synced"`.
- The config key contract is `cloudCreate: "allow" | "deny"`. **Absent = allow** (back-compat: every non-ad-synced client and every already-planned case has no key and must behave exactly as today).
- `m365` and `entra` are the SAME runner handler (`Start-IamRunner.ps1:1529` aliases them) — every web change covers BOTH system keys; the single runner change covers both automatically.
- Only `onboard` cases are affected. Offboard/change/other actions are untouched.
- DECISION_NEEDED marker format is a pinned string contract (see `web/lib/cases/decision-markers.ts`): `DECISION_NEEDED:<kind> | <human message> | k=v | k=v`. The runner's emitted string and the web parser's regex must match exactly, guarded by `decision-markers.test.ts`.
- Bump `runner/VERSION` on any runner change (currently `1.90.0` → `1.91.0`; minor = backward-compatible).
- Ship a changelog entry: one file per entry in `web/lib/changelog/entries/`, registered in `_registry.ts`; `time` is `TZ=America/New_York date +%H:%M` rounded to a 15-min boundary.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

### Task 1: Runner — gate the create branch on `cloudCreate`, add broader synced-user search

**Files:**
- Modify: `runner/modules/Coretelligent.M365/Coretelligent.M365.psm1` (add `Find-CtgM365SyncedUser`; gate the `else { New-MgUser }` block at ~771)
- Test: `runner/tests/Coretelligent.M365.Tests.ps1` (new `Context` inside `Describe 'Invoke-CtgM365Onboarding'`)

**Interfaces:**
- Consumes: `$Config.cloudCreate` (string `"deny"`/`"allow"`/absent) read with `Get-CtgProp`; the existing `$User` (DisplayName, UserPrincipalName) and `$upn` (chosen).
- Produces: new function `Find-CtgM365SyncedUser -User <pscustomobject> -ExpectedUpn <string>` → first synced `MgUser` match or `$null`; two new thrown-error strings — `DECISION_NEEDED:synced_upn_mismatch | <msg> | expected=<upn> | found=<actualUpn> | name=<displayName>` and a plain `no synced M365 account …` failure. The web parser in Task 4 depends on the exact mismatch string.

- [ ] **Step 1: Write the failing tests**

Add this block to `runner/tests/Coretelligent.M365.Tests.ps1`, inside `Describe 'Invoke-CtgM365Onboarding'` (after the existing `BeforeEach` mock setup so it inherits the base mocks):

```powershell
    Context 'ad-synced adopt-only (cloudCreate=deny)' {
        $pwd = ConvertTo-SecureString 'Pw!23456789abc' -AsPlainText -Force
        $user = [pscustomobject]@{ DisplayName='Jane Doe'; UserPrincipalName='jane.doe@x.com'; UserPrincipalNameFallbacks=@(); FirstName='Jane'; LastName='Doe'; JobTitle=''; MobilePhone=''; UsageLocation='US' }

        It 'does NOT create and fails clearly when no account exists anywhere' {
            Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith { $null }   # UPN candidates AND broader search miss
            { Invoke-CtgM365Onboarding -User $user -Config ([pscustomobject]@{ cloudCreate = 'deny' }) -InitialPassword $pwd } |
                Should -Throw -ExpectedMessage '*no synced M365 account*did NOT create*'
            Should -Invoke New-MgUser -ModuleName Coretelligent.M365 -Times 0 -Exactly
        }

        It 'raises DECISION_NEEDED:synced_upn_mismatch when a synced user exists under a DIFFERENT UPN' {
            Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith {
                param($UserId, $Filter)
                # UPN-candidate lookups (by -UserId) miss; the broader displayName+onPremisesSyncEnabled filter hits.
                if ("$Filter" -match "displayName eq 'Jane Doe'") {
                    return [pscustomobject]@{ Id='uid-synced'; DisplayName='Jane Doe'; UserPrincipalName='jdoe@x.com'; OnPremisesSyncEnabled=$true }
                }
                return $null
            }
            { Invoke-CtgM365Onboarding -User $user -Config ([pscustomobject]@{ cloudCreate = 'deny' }) -InitialPassword $pwd } |
                Should -Throw -ExpectedMessage '*DECISION_NEEDED:synced_upn_mismatch*found=jdoe@x.com*expected=jane.doe@x.com*'
            Should -Invoke New-MgUser -ModuleName Coretelligent.M365 -Times 0 -Exactly
        }

        It 'STILL creates when cloudCreate=allow and no account exists (override / non-ad-synced)' {
            Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith { $null }
            $r = Invoke-CtgM365Onboarding -User $user -Config ([pscustomobject]@{ cloudCreate = 'allow' }) -InitialPassword $pwd
            $r.Status | Should -Be 'ok'
            Should -Invoke New-MgUser -ModuleName Coretelligent.M365 -Times 1 -Exactly
        }
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `~/.local/pwsh/pwsh -NoProfile -Command "Invoke-Pester -Path runner/tests/Coretelligent.M365.Tests.ps1 -Output Detailed"`
Expected: the two `deny` tests FAIL (the module currently calls `New-MgUser` regardless — `Should -Invoke … -Times 0` fails / no throw). The `allow` test passes (current behavior).

- [ ] **Step 3: Add the `Find-CtgM365SyncedUser` helper**

Insert this function in `Coretelligent.M365.psm1` immediately BEFORE `function Invoke-CtgM365Onboarding {` (~line 667):

```powershell
function Find-CtgM365SyncedUser {
    <#
    .SYNOPSIS
        Locate a directory-synced (on-prem mastered) M365 user for THIS person whose UPN differs from
        the expected one — the tell-tale of a wrong on-prem email/UPN. Read-only: used ONLY to explain a
        "no account found" on an ad-synced client, never to write. Returns the first synced match or $null.
    #>
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][string]$ExpectedUpn
    )
    $props = @('Id', 'DisplayName', 'UserPrincipalName', 'Mail', 'OnPremisesSyncEnabled')
    $name = ([string]$User.DisplayName).Trim()
    # 1) A synced user with this display name catches a wrong UPN (the reported case). Escape single quotes.
    if ($name) {
        $safe = $name.Replace("'", "''")
        $hits = @(Get-MgUser -Filter "displayName eq '$safe' and onPremisesSyncEnabled eq true" -Property $props -All -ErrorAction SilentlyContinue)
        if ($hits) { return $hits[0] }
    }
    # 2) Fall back to a synced user whose mail equals the expected address (wrong UPN, right mail).
    if ($ExpectedUpn) {
        $safeMail = $ExpectedUpn.Replace("'", "''")
        $hits = @(Get-MgUser -Filter "mail eq '$safeMail' and onPremisesSyncEnabled eq true" -Property $props -All -ErrorAction SilentlyContinue)
        if ($hits) { return $hits[0] }
    }
    return $null
}
```

- [ ] **Step 4: Gate the create branch**

In `Invoke-CtgM365Onboarding`, replace the opening of the create branch. Current code (~771):

```powershell
    else {
        if ($PSCmdlet.ShouldProcess($upn, "Create M365 user")) {
```

becomes:

```powershell
    else {
        # AD-synced clients: the cloud account originates on-prem via Entra Connect — never create it
        # here. cloudCreate is stamped at plan time ('deny' for ad_synced without an override); absent =
        # allow, so every non-ad-synced client and pre-existing case behaves exactly as before.
        if ([string](Get-CtgProp $Config 'cloudCreate') -ieq 'deny') {
            $synced = Find-CtgM365SyncedUser -User $User -ExpectedUpn $upn
            if ($synced) {
                $found = [string]$synced.UserPrincipalName
                throw "DECISION_NEEDED:synced_upn_mismatch | A synced account for '$($User.DisplayName)' exists at $found but the onboarding expected $upn — the on-prem UPN/email looks wrong. Fix the AD email and re-sync, or allow cloud creation on this case. Did NOT create in cloud. | expected=$upn | found=$found | name=$($User.DisplayName)"
            }
            throw "no synced M365 account for $($User.DisplayName) at $upn — this is an AD-synced client, so the account must arrive from on-prem AD via Entra Connect. AD sync is pending or the on-prem UPN/email is wrong; did NOT create in cloud. Fix AD and re-sync, or allow cloud creation on the case."
        }
        if ($PSCmdlet.ShouldProcess($upn, "Create M365 user")) {
```

(The rest of the create block — `$passwordProfile`, `$params`, `New-MgUser`, the closing braces — is unchanged.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `~/.local/pwsh/pwsh -NoProfile -Command "Invoke-Pester -Path runner/tests/Coretelligent.M365.Tests.ps1 -Output Detailed"`
Expected: all three new tests PASS; the whole file's existing tests still PASS.

- [ ] **Step 6: Commit**

```bash
git add runner/modules/Coretelligent.M365/Coretelligent.M365.psm1 runner/tests/Coretelligent.M365.Tests.ps1
git commit -m "Runner: ad-synced M365 onboard is adopt-only (gate create on cloudCreate)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Web — thread `backbone` into planning and stamp `cloudCreate` at plan time

**Files:**
- Modify: `web/lib/cases/repository.ts` (`clientForPlanning`: add `backbone` to the select, the return type, and the parent-inheritance fallback)
- Modify: `web/lib/profiles/plan-resolve.ts` (add `backbone` to `PlanClient`; stamp `cloudCreate` onto m365/entra onboard jobs for ad_synced clients)
- Test: `web/lib/profiles/plan-resolve.test.ts` (new tests)

**Interfaces:**
- Consumes: `client.backbone` (`string | null`) on the `PlanClient` passed to `resolvePlannedConfigs`; the per-case override `payload.allowCloudCreate === true`; the persistent flag `cfg.allowCloudCreate === true` on the resolved m365/entra config.
- Produces: each m365/entra onboard job's `config.cloudCreate` = `"deny"` (ad_synced, no override) or `"allow"` (override present). Non-ad-synced clients: key left absent. Task 1's runner reads this key.

- [ ] **Step 1: Write the failing tests**

Add to `web/lib/profiles/plan-resolve.test.ts` (mirror the existing `job()` / `payload` helpers already in the file):

```ts
test("ad_synced client stamps cloudCreate:'deny' on m365 and entra onboard jobs", () => {
  const client = { backbone: "ad_synced", personas: null, globals: null, locations: null };
  const resolved = resolvePlannedConfigs(client, payload, "onboard", [job("m365", {}), job("entra", {}), job("active-directory", {})]);
  expect((resolved.find((j) => j.systemKey === "m365")!.config as Record<string, unknown>).cloudCreate).toBe("deny");
  expect((resolved.find((j) => j.systemKey === "entra")!.config as Record<string, unknown>).cloudCreate).toBe("deny");
  // AD lane is never stamped.
  expect((resolved.find((j) => j.systemKey === "active-directory")!.config as Record<string, unknown>).cloudCreate).toBeUndefined();
});

test("ad_synced with the persistent allowCloudCreate flag stamps 'allow'", () => {
  const client = { backbone: "ad_synced", personas: null, globals: null, locations: null };
  const resolved = resolvePlannedConfigs(client, payload, "onboard", [job("m365", { allowCloudCreate: true })]);
  expect((resolved[0].config as Record<string, unknown>).cloudCreate).toBe("allow");
});

test("ad_synced with the per-case override stamps 'allow'", () => {
  const client = { backbone: "ad_synced", personas: null, globals: null, locations: null };
  const resolved = resolvePlannedConfigs(client, { ...payload, allowCloudCreate: true }, "onboard", [job("m365", {})]);
  expect((resolved[0].config as Record<string, unknown>).cloudCreate).toBe("allow");
});

test("non-ad-synced (entra) backbone never stamps cloudCreate", () => {
  const client = { backbone: "entra", personas: null, globals: null, locations: null };
  const resolved = resolvePlannedConfigs(client, payload, "onboard", [job("m365", {}), job("entra", {})]);
  expect((resolved[0].config as Record<string, unknown>).cloudCreate).toBeUndefined();
  expect((resolved[1].config as Record<string, unknown>).cloudCreate).toBeUndefined();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && npx vitest run lib/profiles/plan-resolve.test.ts`
Expected: the four new tests FAIL (`cloudCreate` is `undefined` everywhere — nothing stamps it yet).

- [ ] **Step 3: Add `backbone` to `PlanClient`**

In `web/lib/profiles/plan-resolve.ts`, extend the `PlanClient` type (~line 12):

```ts
type PlanClient = {
  backbone?: string | null;
  personas?: unknown; globals?: unknown; globalsOffboard?: unknown; locations?: unknown;
  adObjects?: unknown; cloudGroups?: unknown;
};
```

- [ ] **Step 4: Stamp `cloudCreate` in `resolvePlannedConfigs`**

In `resolvePlannedConfigs`, immediately AFTER the `withRehire` block (after line ~312, before the `withLicenses` block), insert:

```ts
  // AD-synced clients: the M365/Entra account originates on-prem via Entra Connect, so the cloud lane
  // must ADOPT the synced user, never create one. Stamp a create policy the runner enforces at its
  // create gate. Absent key = allow (every non-ad-synced client + pre-existing plan is unchanged).
  // Overrides that flip it back to allow: a persistent `allowCloudCreate` on the m365/entra config,
  // or the per-case `payload.allowCloudCreate` (set via /api/cases/[id]/m365-override).
  const CLOUD_CREATE_SYSTEMS = new Set(["m365", "entra"]);
  const caseAllowsCloudCreate = payload.allowCloudCreate === true;
  const withCloudCreate = client.backbone !== "ad_synced"
    ? withRehire
    : withRehire.map((j) => {
        if (!CLOUD_CREATE_SYSTEMS.has(j.systemKey)) return j;
        const cfg = (j.config as Record<string, unknown> | null) ?? {};
        const allow = caseAllowsCloudCreate || cfg.allowCloudCreate === true;
        return { ...j, config: { ...cfg, cloudCreate: allow ? "allow" : "deny" } };
      });
```

Then change the next consumer — `withLicenses` — to read from `withCloudCreate` instead of `withRehire`:

```ts
  const withLicenses = explicitLicenses
    ? withCloudCreate
    : withCloudCreate.map((j) => {
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd web && npx vitest run lib/profiles/plan-resolve.test.ts`
Expected: all four new tests PASS; every existing test in the file still PASSES.

- [ ] **Step 6: Wire `backbone` through `clientForPlanning`**

In `web/lib/cases/repository.ts`, in `clientForPlanning`:

1. Add `backbone: string | null;` to the returned object's type union (the block starting `id: string; name: string; …`):

```ts
          id: string; name: string; slug: string; primaryDomain: string;
          backbone: string | null;
          emailDomain: string | null; emailDomainLocked: boolean; serviceNowSysId: string | null;
```

2. Add `backbone: true,` to the main `db.client.findUnique` `select` (next to `primaryDomain: true,`):

```ts
          id: true, name: true, slug: true, primaryDomain: true,
          backbone: true,
          emailDomain: true, emailDomainLocked: true, serviceNowSysId: true, engineOptOut: true,
```

3. The parent-inheritance branch returns `{ ...c, … }` which already carries the child's own `backbone` — no change needed there (a child's backbone is its own attribute, not inherited from the parent runbook).

- [ ] **Step 7: Run the web type-check / full plan-resolve + repository tests**

Run: `cd web && npx tsc --noEmit && npx vitest run lib/profiles/plan-resolve.test.ts lib/clients/parent-inheritance.test.ts`
Expected: type-check clean; tests PASS.

- [ ] **Step 8: Commit**

```bash
git add web/lib/profiles/plan-resolve.ts web/lib/profiles/plan-resolve.test.ts web/lib/cases/repository.ts
git commit -m "Web: stamp cloudCreate policy for ad-synced onboards at plan time

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Web — per-case override in the m365-override route

**Files:**
- Modify: `web/app/api/cases/[id]/m365-override/route.ts` (accept `allowCloudCreate: true`)
- Test: `web/app/api/cases/[id]/m365-override/route.test.ts` (create if absent; otherwise append)

**Interfaces:**
- Consumes: request body `{ allowCloudCreate: true }`.
- Produces: writes `cloudCreate: "allow"` onto every m365/entra job config via the existing `writeJobConfig`; adds `"cloudCreate:allow"` to the `changed[]` response. This is the override Task 4's picker calls, and it survives re-plan because Task 2 reads `cfg.allowCloudCreate` — but the route writes `cloudCreate` directly so a plain re-run (no re-plan) also picks it up.

- [ ] **Step 1: Write the failing test**

If `web/app/api/cases/[id]/m365-override/route.test.ts` does not exist, create it mirroring the sibling route tests (import `PATCH`, mock `@/lib/db`, `@/lib/auth/route-guard` returning `{ user }`, and `@/lib/auth/client-scope`'s `caseInScope` → true). Add:

```ts
test("allowCloudCreate:true writes cloudCreate=allow onto every m365/entra job", async () => {
  // Arrange: a case with one m365 job and one entra job (see existing test's db mock shape).
  const res = await PATCH(
    new Request("http://t/api/cases/c1/m365-override", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowCloudCreate: true }),
    }),
    { params: { id: "c1" } },
  );
  const body = await res.json();
  expect(res.status).toBe(200);
  expect(body.changed).toContain("cloudCreate:allow");
  // Each job's request.config.cloudCreate === "allow" (assert via the db.job.update mock capture).
});
```

If a route test file with a working `db`/guard mock harness already exists, append just the `test(...)` above and reuse its harness.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run "app/api/cases/[id]/m365-override/route.test.ts"`
Expected: FAIL — `changed` does not contain `"cloudCreate:allow"` (the route ignores the field, returns 422 "nothing to update").

- [ ] **Step 3: Implement the field handling**

In `web/app/api/cases/[id]/m365-override/route.ts`, widen the `body` type to include `allowCloudCreate?: unknown`, then add this block after the `mailboxOversizePolicy` block (before the `userPrincipalName` block):

```ts
  // Per-case override for the FR#25 adopt-only guard: the operator confirms this ad-synced hire really
  // does need a cloud-created account (not an AD-synced one). Writes the runner's allow policy directly
  // so a plain re-run picks it up; a later re-plan re-derives the same 'allow' from cfg.allowCloudCreate.
  if (body.allowCloudCreate === true) {
    const n = await writeJobConfig("cloudCreate", "allow");
    if (!n) return NextResponse.json({ error: "this case has no M365/Entra step to record the choice on" }, { status: 422 });
    changed.push("cloudCreate:allow");
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run "app/api/cases/[id]/m365-override/route.test.ts"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "web/app/api/cases/[id]/m365-override/route.ts" "web/app/api/cases/[id]/m365-override/route.test.ts"
git commit -m "Web: m365-override accepts allowCloudCreate (per-case ad-synced override)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Web — parse the mismatch marker and render the decision picker

**Files:**
- Modify: `web/lib/cases/decision-markers.ts` (add `parseSyncedUpnMismatch`)
- Modify: `web/lib/cases/decision-markers.test.ts` (pin the exact runner string)
- Modify: `web/app/cases/_components/run-report-view.tsx` (add `SyncedMismatchDecision`, render it)

**Interfaces:**
- Consumes: `step.error` containing `DECISION_NEEDED:synced_upn_mismatch | <msg> | expected=<upn> | found=<actualUpn> | name=<displayName>` (the exact string thrown in Task 1).
- Produces: `parseSyncedUpnMismatch(error: string): { message: string; expected: string; found: string; name: string } | null`; a `SyncedMismatchDecision` React component with two actions — "Allow cloud creation & re-run" (PATCH `m365-override` `{ allowCloudCreate: true }` then `rerun`) and a copy-error affordance.

- [ ] **Step 1: Write the failing parser test**

Add to `web/lib/cases/decision-markers.test.ts` (import `parseSyncedUpnMismatch` from the module):

```ts
test("parseSyncedUpnMismatch pulls expected/found/name from the runner's exact string", () => {
  const err = "DECISION_NEEDED:synced_upn_mismatch | A synced account for 'Jane Doe' exists at jdoe@x.com but the onboarding expected jane.doe@x.com — the on-prem UPN/email looks wrong. Fix the AD email and re-sync, or allow cloud creation on this case. Did NOT create in cloud. | expected=jane.doe@x.com | found=jdoe@x.com | name=Jane Doe";
  const d = parseSyncedUpnMismatch(err);
  expect(d).not.toBeNull();
  expect(d!.expected).toBe("jane.doe@x.com");
  expect(d!.found).toBe("jdoe@x.com");
  expect(d!.name).toBe("Jane Doe");
});

test("parseSyncedUpnMismatch returns null on an unrelated error", () => {
  expect(parseSyncedUpnMismatch("some other failure")).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run lib/cases/decision-markers.test.ts`
Expected: FAIL — `parseSyncedUpnMismatch` is not exported.

- [ ] **Step 3: Implement the parser**

Add to `web/lib/cases/decision-markers.ts`:

```ts
// The M365 onboard emits this when an ad-synced client's cloud account can't be found under the
// expected UPN but a synced user for the same person exists under a DIFFERENT one — the tell of a
// wrong on-prem email/UPN. Emitted as a thrown ERROR (not an action line), so the picker reads
// step.error. The exact runner string is pinned in decision-markers.test.ts.
export type SyncedUpnMismatch = { message: string; expected: string; found: string; name: string };

const SYNCED_UPN_MISMATCH = /DECISION_NEEDED:synced_upn_mismatch \| ([^|]+?) \| expected=([^|]+?) \| found=([^|]+?) \| name=(.+)$/;

export function parseSyncedUpnMismatch(error: string): SyncedUpnMismatch | null {
  const m = SYNCED_UPN_MISMATCH.exec(error.trim());
  if (!m) return null;
  return { message: m[1].trim(), expected: m[2].trim(), found: m[3].trim(), name: m[4].trim() };
}
```

- [ ] **Step 4: Run the parser test to verify it passes**

Run: `cd web && npx vitest run lib/cases/decision-markers.test.ts`
Expected: PASS (including the pre-existing marker tests).

- [ ] **Step 5: Add the picker component and render it**

In `web/app/cases/_components/run-report-view.tsx`:

(a) Extend the import at line 13:

```ts
import { parseMailboxOversize, parseMailboxNotConverted, canConvert, isDecisionMarker, parseSyncedUpnMismatch } from "@/lib/cases/decision-markers";
```

(b) Add this component immediately after `CollisionDecision` (after line ~456):

```tsx
// AD-synced client: the runner found a synced account under a different UPN (or none) and refused to
// create a cloud duplicate. The operator either fixes the on-prem AD email and re-syncs (then re-runs),
// or — if this hire legitimately needs a cloud-created account — allows creation for this case.
function SyncedMismatchDecision({ caseId, jobId, error, refresh }: { caseId: string; jobId: string; error: string; refresh: () => Promise<void> | void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const d = parseSyncedUpnMismatch(error);
  if (!d) return null;
  async function allowCreate() {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/cases/${caseId}/m365-override`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ allowCloudCreate: true }) });
      if (!r.ok) { setErr(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "failed"); return; }
      await fetch(`/api/jobs/${jobId}/rerun`, { method: "POST" });
      await refresh();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <div style={{ border: "1px solid #fde68a", background: "#fffbeb", borderRadius: 8, padding: "0.6rem 0.8rem", marginTop: 6 }}>
      <div style={{ fontSize: 13, color: "#92400e" }}>
        <b>Decision needed</b> — this AD-synced client&apos;s account should come from on-prem AD, so nothing was created in the cloud.
        {d.found ? <> A synced account for <b>{d.name}</b> exists at <code>{d.found}</code> but onboarding expected <code>{d.expected}</code>.</> : null}
      </div>
      <div className="note" style={{ marginTop: 4 }}>Fix the on-prem AD email/UPN and re-sync (then re-run this step), or allow a cloud account for this case:</div>
      <div className="toolbar" style={{ marginTop: 8 }}>
        <button className="primary" disabled={busy} onClick={allowCreate}>{busy ? "Allowing…" : "Allow cloud account for this case & re-run"}</button>
      </div>
      {err && <p className="note danger" style={{ marginTop: 4 }}>{err}</p>}
    </div>
  );
}
```

(c) Render it next to the collision picker (after line ~1165):

```tsx
              {step.error?.includes("DECISION_NEEDED:username_collision") && step.jobId && (
                <CollisionDecision caseId={caseId} jobId={step.jobId} error={step.error} refresh={refresh} />
              )}
              {step.error?.includes("DECISION_NEEDED:synced_upn_mismatch") && step.jobId && (
                <SyncedMismatchDecision caseId={caseId} jobId={step.jobId} error={step.error} refresh={refresh} />
              )}
```

- [ ] **Step 6: Type-check and run the web test suite touched here**

Run: `cd web && npx tsc --noEmit && npx vitest run lib/cases/decision-markers.test.ts`
Expected: type-check clean; tests PASS.

- [ ] **Step 7: Commit**

```bash
git add web/lib/cases/decision-markers.ts web/lib/cases/decision-markers.test.ts web/app/cases/_components/run-report-view.tsx
git commit -m "Web: surface synced_upn_mismatch as a case decision picker

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Version bump + changelog entry

**Files:**
- Modify: `runner/VERSION`
- Create: `web/lib/changelog/entries/ad-synced-adopt-only.ts`
- Modify: `web/lib/changelog/entries/_registry.ts`

**Interfaces:**
- Consumes: nothing at runtime; `_registry.ts` re-exports every entry and `registry.test.ts` fails on a missing registration.
- Produces: `runner/VERSION` = `1.91.0`; one changelog entry.

- [ ] **Step 1: Bump the runner version**

Set `runner/VERSION` to exactly:

```
1.91.0
```

- [ ] **Step 2: Compute the Eastern timestamp**

Run: `TZ=America/New_York date "+%Y-%m-%d %H:%M"`
Round the time DOWN to the nearest 15-min boundary (`:00`, `:15`, `:30`, `:45`). Use these as `date` and `time` below.

- [ ] **Step 3: Create the changelog entry**

Create `web/lib/changelog/entries/ad-synced-adopt-only.ts` (substitute the real date/time from Step 2):

```ts
import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "ad-synced-adopt-only",
  date: "2026-07-22",
  time: "HH:MM",
  title: "AD-synced clients no longer create M365 accounts by mistake — the account must come from AD",
  items: [
    "For an AD-synced client, an onboarding's M365/Entra step now ADOPTS the account that syncs up from on-prem Active Directory and never creates a cloud one — so a wrong on-prem email/UPN can no longer make 365 quietly create a duplicate cloud account",
    "When the expected account isn't found, the step searches for a synced user with the same name: if one exists under a different sign-in name it pauses the case with a 'Decision needed' picker showing the found vs expected address (usually a wrong AD email to fix and re-sync); if none exists it fails clearly with 'did NOT create in cloud'",
    "If a particular hire really does need a cloud-created account, an operator can allow it for that one case (the picker's 'Allow cloud account for this case & re-run'), or a client can be set to always allow creation via allowCloudCreate on its M365/Entra config",
    "Non-AD-synced clients (e.g. cloud-only Entra) are unchanged — they create accounts exactly as before",
  ],
};
```

- [ ] **Step 4: Register the entry**

In `web/lib/changelog/entries/_registry.ts`, add the export line in its sorted (by id) position — after the `adAmbientAuthFirst`/`adDcOptional` group, before `adFolderTreePicker`:

```ts
export { entry as adSyncedAdoptOnly } from "./ad-synced-adopt-only";
```

- [ ] **Step 5: Run the changelog registry test**

Run: `cd web && npx vitest run lib/changelog/registry.test.ts`
Expected: PASS (every entry file is registered; date/time well-formed).

- [ ] **Step 6: Commit**

```bash
git add runner/VERSION web/lib/changelog/entries/ad-synced-adopt-only.ts web/lib/changelog/entries/_registry.ts
git commit -m "Runner 1.91.0 + changelog: ad-synced adopt-only onboard (FR #25)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] Runner tests: `~/.local/pwsh/pwsh -NoProfile -Command "Invoke-Pester -Path runner/tests/Coretelligent.M365.Tests.ps1 -Output Detailed"` — all green.
- [ ] Web tests: `cd web && npx vitest run && npx tsc --noEmit` — all green.
- [ ] Re-read FR #25: does the change stop 365 from creating a user when the AD email is wrong, and does it either find the incorrect username or tell the operator it couldn't create correctly? (Yes: DECISION_NEEDED with found-vs-expected, or a clear "did NOT create" failure.)

## Self-Review (completed by plan author)

- **Spec coverage:** policy (Task 2 + Task 1) ✓; persistent override (Task 2 reads `cfg.allowCloudCreate`) ✓; per-case override (Task 3 route + Task 4 picker) ✓; broader search (Task 1 `Find-CtgM365SyncedUser`) ✓; DECISION_NEEDED/clean-fail surfacing (Task 1 throws + Task 4 picker) ✓; tests (every task) ✓; version bump + changelog (Task 5) ✓; out-of-scope items (ad_standalone, sync-wait, auto-fix) excluded ✓.
- **Placeholder scan:** only the changelog `time` is computed at ship (Step 2 gives the exact command) — every code block is complete.
- **Type/string consistency:** the thrown marker `DECISION_NEEDED:synced_upn_mismatch | … | expected= | found= | name=` (Task 1) matches the regex in Task 4 exactly; `cloudCreate`/`allowCloudCreate` key names are consistent across Tasks 1–3; `Find-CtgM365SyncedUser` signature matches its call site.
