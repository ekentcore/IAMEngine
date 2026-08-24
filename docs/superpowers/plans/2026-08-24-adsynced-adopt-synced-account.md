# AD-synced onboards adopt the synced account (FR #105 + #92) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stop AD-synced onboards hard-failing on "all candidate usernames are taken by other users"
when the account they should adopt is sitting right there, and make an exhausted candidate list offer
Adopt instead of dead-ending.

**Architecture:** Two changes in the M365 module's username picker, both narrow. (1) An account that is
directory-synced has its `extensionAttribute1` mastered on-prem, so that value says nothing about who
provisioned the account — stop letting it veto the name-match branch. (2) When every candidate is
occupied, raise the existing `DECISION_NEEDED:username_collision` marker instead of a bare error, so the
Adopt / Different-person UI that already exists is offered.

**Tech Stack:** PowerShell 7 (`Coretelligent.M365`), Pester 6, TypeScript changelog entry.

**Spec:** `docs/superpowers/specs/2026-08-17-open-feature-requests-batch-2-design.md` (items 6 and 11)

## Why the spec's diagnosis is superseded

The spec ranked #105 as "AD-synced clients still create 365 accounts instead of adopting" and told the
implementer to check three things. All three were checked on 2026-08-24 and the answer is that **adopt-only
is working**:

- core2030 (Apollon Wealth Management) IS flagged `ad_synced`.
- It has no `allowCloudCreate`, so `plan-resolve.ts:392` stamps `cloudCreate: "deny"`, and every m365 job
  on every recent case carries it.
- The runner's create gate (`Coretelligent.M365.psm1:1024`) honours it. **No cloud account has been created.**

The actual failure, on 5 of the last 8 onboards for that client:

| Case | Date | m365 outcome |
|---|---|---|
| UM0030780 | 2026-08-21 | all candidate usernames are taken |
| UM0030675 | 2026-08-20 | no synced account — the deny gate firing correctly |
| UM0030616 | 2026-08-16 | all candidate usernames are taken (had `usernameCollisionPolicy=adopt`) |
| UM0030500 | 2026-08-11 | all candidate usernames are taken |
| UM0030328 | 2026-08-10 | all candidate usernames are taken |
| UM0029901 | 2026-08-05 | all candidate usernames are taken |

UM0029901's own progress trail is the proof: it expected **"Tina Montz"** and logged
`↪ tina.montz@apollonfinancial.com taken by Tina Montz — trying fallback`. Identical names, rejected.

## Root cause

`Coretelligent.M365.psm1:985` gates the adopt/ask branch on a conjunction:

```powershell
if (-not $foundMarker -and (& $nameMatches $found.DisplayName)) {
```

`$targetName` is populated (the job payload carries `displayName`), so the name half is TRUE. The half
that fails is `-not $foundMarker`. `$foundMarker` is
`onPremisesExtensionAttributes.extensionAttribute1`, and on a directory-synced account that attribute is
**mastered on-prem** — Entra Connect copies whatever the client's AD holds. Apollon's AD populates it, so
every synced account arrives carrying a value that is not our marker, the branch is skipped, and the loop
falls through to "taken by a different user". This client has one username pattern and therefore no
fallbacks, so it immediately throws.

Two corroborations: the error appears on 5 jobs, all `ad_synced`, zero across 113 `entra` onboards; and
the same attribute is read-only in Entra for synced users, so the marker-stamping at line 1015 could never
work on this lane either.

**Confirm before coding (Task 0):** the elimination is strong but indirect. One Graph read settles it.

## Why #92 is the same work item

#92 ("a taken username fails instead of offering to adopt") is the same decision path, exactly as the spec
predicted when it sequenced #92 after #105. #105 is what happens when `extensionAttribute1` is populated
(hard fail, no ask at all); #92 is what happens when it is empty (you get the ask, or on an exhausted list,
the same dead end). One fix, two closures.

## Global Constraints

- The two-John-Smiths safety property must survive: on a **cloud-only** account we only ever write
  `extensionAttribute1` ourselves, so a foreign value there genuinely means a different person and must
  keep vetoing the name match. Only sync-mastered values are discounted.
- The `DECISION_NEEDED:username_collision` message must keep the exact shape
  `... | <message with no pipe characters> | upn=<upn> | name=<name>`, because
  `run-report-view.tsx:478` parses it with
  `/DECISION_NEEDED:username_collision \| ([^|]+?) \| upn=([^|]+?) \| name=(.+)$/`.
- Runner change means a `runner/VERSION` bump (1.108.0 to **1.109.0**) and a runner deploy. The web half
  ships on merge; the runner half does not.
- Baseline to beat: web 2149 pass / 6 known fail; `Coretelligent.M365.Tests.ps1` 171 pass / 0 fail.

---

### Task 0: Confirm the root cause against the live tenant

**Files:** none — read-only verification.

**Interfaces:**
- Consumes: nothing.
- Produces: a yes/no that gates every later task.

- [ ] **Step 1: Read the attribute on one affected account**

Against the Apollon tenant, for any of the five names above:

```powershell
Get-MgUser -UserId 'tina.montz@apollonfinancial.com' -Property 'Id,DisplayName,OnPremisesSyncEnabled,OnPremisesExtensionAttributes' |
  Select-Object DisplayName, OnPremisesSyncEnabled -ExpandProperty OnPremisesExtensionAttributes
```

Expected: `OnPremisesSyncEnabled = True` and `ExtensionAttribute1` NON-EMPTY and not an email we wrote.

- [ ] **Step 2: Record the result in this plan**

If confirmed, continue. If `ExtensionAttribute1` is EMPTY, STOP — the root cause is then a DisplayName
mismatch invisible in the log (a non-breaking space or a homoglyph), and Task 1 is the wrong fix.

---

### Task 1: A sync-mastered extensionAttribute1 stops vetoing the name match

**Files:**
- Modify: `runner/modules/Coretelligent.M365/Coretelligent.M365.psm1:979` and `:983-990`
- Test: `runner/tests/Coretelligent.M365.Tests.ps1`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: the candidate loop still reaches its fall-through for genuinely different people, which Task 2
  depends on.

- [ ] **Step 1: Write the failing tests**

Add inside the existing `Context 'ad-synced adopt-only (cloudCreate=deny)'` block. Note the Pester v5 rule
already recorded there: build `$user` and `$pwd` INSIDE each `It`, never at Context scope.

```powershell
It 'ADOPTS a directory-synced same-name account whose extensionAttribute1 is mastered on-prem (FR #0000105)' {
    $user = [pscustomobject]@{ DisplayName='Tina Montz'; UserPrincipalName='tina.montz@x.com'; UserPrincipalNameFallbacks=@(); FirstName='Tina'; LastName='Montz'; JobTitle=''; MobilePhone=''; UsageLocation='US' }
    $pwd  = ConvertTo-SecureString 'Pw!23456789abc' -AsPlainText -Force
    Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith {
        [pscustomobject]@{ Id='uid-tina'; DisplayName='Tina Montz'; AccountEnabled=$true; OnPremisesSyncEnabled=$true;
                           OnPremisesExtensionAttributes = [pscustomobject]@{ ExtensionAttribute1 = 'AWM-EMP-4417' } }
    }
    $r = Invoke-CtgM365Onboarding -User $user -Config ([pscustomobject]@{ cloudCreate='deny'; usernameCollisionPolicy='adopt' }) -InitialPassword $pwd
    $r.Status | Should -Be 'ok'
    Should -Invoke New-MgUser -ModuleName Coretelligent.M365 -Times 0 -Exactly
    ($r.Actions -join ' ') | Should -Match 'mastered on-prem'
    ($r.Actions -join ' ') | Should -Match 'operator chose ADOPT'
}

It 'ASKS (does not dead-end) on a synced same-name account with an on-prem attribute and no policy yet' {
    $user = [pscustomobject]@{ DisplayName='Tina Montz'; UserPrincipalName='tina.montz@x.com'; UserPrincipalNameFallbacks=@(); FirstName='Tina'; LastName='Montz'; JobTitle=''; MobilePhone=''; UsageLocation='US' }
    $pwd  = ConvertTo-SecureString 'Pw!23456789abc' -AsPlainText -Force
    Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith {
        [pscustomobject]@{ Id='uid-tina'; DisplayName='Tina Montz'; AccountEnabled=$true; OnPremisesSyncEnabled=$true;
                           OnPremisesExtensionAttributes = [pscustomobject]@{ ExtensionAttribute1 = 'AWM-EMP-4417' } }
    }
    { Invoke-CtgM365Onboarding -User $user -Config ([pscustomobject]@{ cloudCreate='deny' }) -InitialPassword $pwd } |
        Should -Throw -ExpectedMessage '*DECISION_NEEDED:username_collision*'
    Should -Invoke New-MgUser -ModuleName Coretelligent.M365 -Times 0 -Exactly
}

It 'still treats a CLOUD-ONLY account with a foreign marker as a different person (two John Smiths)' {
    # The safety property this fix must not weaken: on a cloud account we are the only writer of
    # extensionAttribute1, so a foreign value really does mean we provisioned it for someone else.
    $user = [pscustomobject]@{ DisplayName='John Smith'; UserPrincipalName='john.smith@x.com'; UserPrincipalNameFallbacks=@('j.smith@x.com'); FirstName='John'; LastName='Smith'; JobTitle=''; MobilePhone=''; UsageLocation='US' }
    $pwd  = ConvertTo-SecureString 'Pw!23456789abc' -AsPlainText -Force
    Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith {
        param($UserId, $Filter)
        if ($UserId -eq 'john.smith@x.com') {
            return [pscustomobject]@{ Id='uid-other'; DisplayName='John Smith'; AccountEnabled=$true; OnPremisesSyncEnabled=$false;
                                      OnPremisesExtensionAttributes = [pscustomobject]@{ ExtensionAttribute1 = 'someone.else@gmail.com' } }
        }
        return $null
    }
    $r = Invoke-CtgM365Onboarding -User $user -Config ([pscustomobject]@{}) -InitialPassword $pwd
    ($r.Actions -join ' ') | Should -Match 'taken by a different user'
    $r.Upn | Should -Be 'j.smith@x.com'
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd runner && pwsh -NoProfile -Command "Invoke-Pester -Path ./tests/Coretelligent.M365.Tests.ps1 -Output Detailed"`

Expected: the first two FAIL with `all candidate usernames are taken by other users`; the third already
PASSES — it is the regression guard, and a green result there before the change is the point.

- [ ] **Step 3: Add OnPremisesSyncEnabled to the property list**

At line 979, extend the property list so the picker can see whether the account is on-prem mastered:

```powershell
        $found = Resolve-CtgM365User -Upn $cand -Property @('Id', 'DisplayName', 'AccountEnabled', 'OnPremisesExtensionAttributes', 'OnPremisesSyncEnabled')
```

- [ ] **Step 4: Discount a sync-mastered marker**

Insert immediately AFTER the marker-equality branch (the `if ($foundMarker -and $foundMarker -ieq $marker)`
block that breaks out on a re-run) and BEFORE the `if (-not $foundMarker -and ...)` name branch. Order
matters: clearing it earlier would break the genuine re-run path, which must still match on our own marker.

```powershell
        # A DIRECTORY-SYNCED account's extensionAttribute1 is MASTERED ON-PREM — Entra Connect copies
        # whatever the client's own AD holds, and Graph cannot write it back on this lane. So the value
        # says NOTHING about who provisioned the account, yet a non-empty one used to veto the name-match
        # branch below: a correctly-synced account read as "a different user" and the onboard hard-failed
        # with every candidate exhausted (FR #0000105 — Apollon, 5 of 8 onboards, because their AD fills
        # extensionAttribute1). Discount it and let the name decide. Cloud-only accounts are untouched:
        # there we are the only writer, so a foreign value genuinely means a different person.
        if ($foundMarker -and [bool](Get-CtgProp $found 'OnPremisesSyncEnabled')) {
            $actions.Add("note: $cand is directory-synced and its extensionAttribute1 ('$foundMarker') is mastered on-prem, not one of ours — ignoring it and matching on name instead")
            Write-CtgM365Step "↪ $cand is on-prem mastered — its extensionAttribute1 is not a provisioning marker"
            $foundMarker = ''
        }
```

- [ ] **Step 5: Run the tests**

Run: `cd runner && pwsh -NoProfile -Command "Invoke-Pester -Path ./tests/Coretelligent.M365.Tests.ps1 -Output Detailed"`

Expected: all three PASS, and the pre-existing 171 still pass.

- [ ] **Step 6: Commit**

```bash
git add runner/modules/Coretelligent.M365/Coretelligent.M365.psm1 runner/tests/Coretelligent.M365.Tests.ps1
git commit -m "FR #105: a synced account's on-prem extensionAttribute1 is not a provisioning marker"
```

---

### Task 2: An exhausted candidate list offers Adopt instead of dead-ending

**Files:**
- Modify: `runner/modules/Coretelligent.M365/Coretelligent.M365.psm1:962-1008`
- Test: `runner/tests/Coretelligent.M365.Tests.ps1`

**Interfaces:**
- Consumes: the candidate loop from Task 1, specifically its fall-through branch.
- Produces: a `DECISION_NEEDED:username_collision` throw whose shape `run-report-view.tsx:478` already parses.

- [ ] **Step 1: Write the failing tests**

```powershell
It 'OFFERS Adopt when every candidate is taken and no decision has been made yet (FR #0000092)' {
    $user = [pscustomobject]@{ DisplayName='Jane Doe'; UserPrincipalName='jane.doe@x.com'; UserPrincipalNameFallbacks=@(); FirstName='Jane'; LastName='Doe'; JobTitle=''; MobilePhone=''; UsageLocation='US' }
    $pwd  = ConvertTo-SecureString 'Pw!23456789abc' -AsPlainText -Force
    Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith {
        param($UserId, $Filter)
        if ($UserId -eq 'jane.doe@x.com') { return [pscustomobject]@{ Id='uid-jd'; DisplayName='Jane N Doe'; AccountEnabled=$true } }
        return $null
    }
    { Invoke-CtgM365Onboarding -User $user -Config ([pscustomobject]@{}) -InitialPassword $pwd } |
        Should -Throw -ExpectedMessage '*DECISION_NEEDED:username_collision*upn=jane.doe@x.com*name=Jane N Doe*'
    Should -Invoke New-MgUser -ModuleName Coretelligent.M365 -Times 0 -Exactly
}

It 'the exhausted-candidates decision matches the shape the case UI parses' {
    # run-report-view.tsx:478 parses exactly this; a stray pipe in the message would silently hide the
    # Adopt / Different person buttons and leave the operator with a wall of red text.
    $user = [pscustomobject]@{ DisplayName='Jane Doe'; UserPrincipalName='jane.doe@x.com'; UserPrincipalNameFallbacks=@(); FirstName='Jane'; LastName='Doe'; JobTitle=''; MobilePhone=''; UsageLocation='US' }
    $pwd  = ConvertTo-SecureString 'Pw!23456789abc' -AsPlainText -Force
    Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith {
        param($UserId, $Filter)
        if ($UserId -eq 'jane.doe@x.com') { return [pscustomobject]@{ Id='uid-jd'; DisplayName='Jane N Doe'; AccountEnabled=$true } }
        return $null
    }
    $msg = ''
    try { Invoke-CtgM365Onboarding -User $user -Config ([pscustomobject]@{}) -InitialPassword $pwd } catch { $msg = $_.Exception.Message }
    $msg | Should -Match 'DECISION_NEEDED:username_collision \| [^|]+ \| upn=[^|]+ \| name=.+$'
}

It 'keeps the plain exhausted error once the operator has said DIFFERENT PERSON' {
    # collisionPolicy 'new' means they already rejected adoption; re-asking would loop them forever.
    $user = [pscustomobject]@{ DisplayName='Jane Doe'; UserPrincipalName='jane.doe@x.com'; UserPrincipalNameFallbacks=@(); FirstName='Jane'; LastName='Doe'; JobTitle=''; MobilePhone=''; UsageLocation='US' }
    $pwd  = ConvertTo-SecureString 'Pw!23456789abc' -AsPlainText -Force
    Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith {
        param($UserId, $Filter)
        if ($UserId -eq 'jane.doe@x.com') { return [pscustomobject]@{ Id='uid-jd'; DisplayName='Jane N Doe'; AccountEnabled=$true } }
        return $null
    }
    { Invoke-CtgM365Onboarding -User $user -Config ([pscustomobject]@{ usernameCollisionPolicy='new' }) -InitialPassword $pwd } |
        Should -Throw -ExpectedMessage '*all candidate usernames are taken by other users*'
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd runner && pwsh -NoProfile -Command "Invoke-Pester -Path ./tests/Coretelligent.M365.Tests.ps1 -Output Detailed"`

Expected: the first two FAIL (they get the plain "all candidate usernames are taken" error); the third PASSES.

- [ ] **Step 3: Remember the first occupied candidate**

Alongside the other loop-state declarations (`$existing = $null`, `$chosenUpn = $null`, `$adopt = $false`),
add two more:

```powershell
    $takenUpn = $null
    $takenBy = $null
```

Then in the loop's fall-through — immediately BEFORE the existing
`$actions.Add("username '$cand' is taken by a different user ...")` line — record the first one seen:

```powershell
        if (-not $takenUpn) { $takenUpn = $cand; $takenBy = [string]$found.DisplayName }
```

- [ ] **Step 4: Offer the decision instead of dead-ending**

Replace the whole `if (-not $chosenUpn) { throw ... }` block with:

```powershell
    if (-not $chosenUpn) {
        # Every candidate is occupied. Dead-ending here is the wrong answer (FR #0000092): the account
        # sitting on the primary candidate is very often the right person under a display name that
        # doesn't match the ticket exactly (a middle initial, a maiden name, "Last, First" from a
        # directory import). The case UI already renders Adopt / Different person from this marker, so
        # ASK. Once the operator has said 'new' they have rejected adoption, and asking again would loop
        # them forever — that case keeps the plain error, which by then genuinely IS "add a fallback".
        if ($takenUpn -and $collisionPolicy -ine 'new') {
            throw "DECISION_NEEDED:username_collision | Every candidate username is already in use. $takenUpn belongs to '$takenBy', which doesn't match this hire's name. If that IS this person, choose Adopt; if not, pick a different username. | upn=$takenUpn | name=$takenBy"
        }
        throw "all candidate usernames are taken by other users: $($candidates -join ', '). Add another username fallback pattern (e.g. {firstinitial}{last}), or assign one manually."
    }
```

- [ ] **Step 5: Run the tests**

Run: `cd runner && pwsh -NoProfile -Command "Invoke-Pester -Path ./tests/Coretelligent.M365.Tests.ps1 -Output Detailed"`

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add runner/modules/Coretelligent.M365/Coretelligent.M365.psm1 runner/tests/Coretelligent.M365.Tests.ps1
git commit -m "FR #92: an exhausted candidate list offers Adopt instead of dead-ending"
```

---

### Task 3: Version bump and changelog

**Files:**
- Modify: `runner/VERSION`
- Create: `web/lib/changelog/entries/adsynced-adopt-synced-account.ts`
- Modify: `web/lib/changelog/entries/_registry.ts` (one id-ordered line)

**Interfaces:**
- Consumes: the behaviour shipped by Tasks 1 and 2, which the entry describes.
- Produces: nothing later tasks read.

- [ ] **Step 1: Bump the runner version**

```bash
echo "1.109.0" > runner/VERSION
```

- [ ] **Step 2: Write the changelog entry**

Create `web/lib/changelog/entries/adsynced-adopt-synced-account.ts`:

```typescript
import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "adsynced-adopt-synced-account",
  date: "2026-08-24",
  time: "10:00",
  title: "AD-synced onboards adopt the account that synced up, instead of failing on it",
  items: [
    "An AD-synced onboard could fail with \"all candidate usernames are taken by other users\" while pointing at an account with the SAME NAME as the hire — the very account it was supposed to adopt. Apollon hit this on 5 of its last 8 onboards. (FR #0000105)",
    "Cause: we tell our own accounts apart by a marker we stamp on extensionAttribute1. On a directory-synced account that attribute is mastered ON-PREM — Entra Connect copies whatever the client's AD holds, and Graph cannot write it back — so a client that uses extensionAttribute1 for its own purposes made every synced account look like it belonged to somebody else. The name was never even checked",
    "A synced account's extensionAttribute1 is no longer read as a provisioning marker; the name decides. Cloud-only accounts are unchanged, where a foreign marker still means a different person — two same-named people are never cross-assigned",
    "When every candidate username is taken, the case now offers Adopt / Different person instead of dead-ending. The account on the primary username is often the right person under a slightly different display name — a middle initial, a maiden name, \"Last, First\" from a directory import. (FR #0000092)",
    "Once you have answered \"different person\" the plain error comes back, because at that point adding a fallback username pattern really is the fix",
    "Runner 1.109.0 (M365 module) needs deploy",
  ],
};
```

- [ ] **Step 3: Register it**

Add the id-ordered line to `web/lib/changelog/entries/_registry.ts` (it sorts just after
`adStandaloneDomainSeparation`):

```typescript
export { entry as adsyncedAdoptSyncedAccount } from "./adsynced-adopt-synced-account";
```

- [ ] **Step 4: Verify both suites**

Run: `cd web && npm test`

Expected: 2149 pass and the same 6 known failures, no new ones.

Run: `cd runner && pwsh -NoProfile -Command "Invoke-Pester -Path ./tests/Coretelligent.M365.Tests.ps1 -Output Minimal"`

Expected: 177 pass / 0 fail (171 existing + 6 new).

- [ ] **Step 5: Commit**

```bash
git add runner/VERSION web/lib/changelog/entries/
git commit -m "Changelog + runner 1.109.0 for the AD-synced adopt fix"
```

---

## Out of scope, deliberately

- **No web change.** The Adopt / Different-person UI, the `m365-override` route that records the answer,
  and the re-run wiring all already exist and are reused as-is. If a task finds itself editing
  `run-report-view.tsx`, stop — the message shape is wrong, not the UI.
- **No change to the `cloudCreate` deny gate.** It works; FR #25 is intact.
- **No new operator setting.** Discounting a sync-mastered marker is always correct on that lane; making it
  configurable would only offer a way to turn the bug back on.

## Risks

- **The safety property.** Loosening a marker check on the identity path is exactly the "wrong accounts at
  scale" risk the spec flags. The mitigation is that the loosening is conditioned on
  `OnPremisesSyncEnabled`, and the cloud-only regression guard in Task 1 Step 1 pins it.
- **Task 0 is not optional.** If `extensionAttribute1` turns out to be empty on those accounts, the whole
  diagnosis is wrong and Task 1 fixes nothing.
- **Runner deploy.** The web half ships on merge; agents pick up 1.109.0 on their next heartbeat. Until they
  do, the affected onboards keep failing the old way.
