# The AD/Entra consistency check stops passing what it never checked (FR #93) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** When the consistency check has no Entra object to compare against, say so — instead of
reporting the reassuring "(ok)" line that made an unverified case look verified.

**Architecture:** The app already injects the Entra anchor into the job payload as `cloudObject`. Teach
that injection to distinguish "read it, there is no cloud object" from "never got to read it", and teach
the runner to report the second honestly.

**Tech Stack:** TypeScript, PowerShell 7 (`Coretelligent.ActiveDirectory`), Pester 6, `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-17-open-feature-requests-batch-2-design.md` (item 5)

## Diagnosis (confirmed 2026-08-25) — and a correction to the request

The request says the check *"always reports that no matching Entra object was found."* **It does not.**
Across every `ad-consistency-check` job that has ever succeeded:

| | |
|---|---|
| Succeeded checks | **39** |
| Reached a real verdict (linked / mismatch / no-immutableId) | **33** |
| Reported "no matching Entra object" | **6** |

So the check works. What is true — and is a real defect — is that **all 6 of those are cases where the
m365 step returned no `UserId`**, and in that situation the check reports an all-clear for a comparison
it never performed.

The requester's "always" is honest reporting from where they sat: they filed it from UM0029901 on
**core2030 (Apollon)**, the client whose m365 step was failing on most onboards (FR #105). On their cases
it really was always.

### The exact mechanism, from the reported case

UM0029901's job timeline:

```
seq 3 m365                 failed     18:20:15
seq 8 ad-email-writeback   succeeded  18:27:35
seq 9 ad-consistency-check succeeded  18:27:36   deps=["m365","ad-email-writeback"]
      · no matching Entra object reported — a fresh sync will create + anchor it (ok)
```

1. m365 fails.
2. The operator **accepts** the failure so the case can proceed.
3. `blockingJobs` (`runner-logic.ts:61`) treats an accepted failure as satisfying a dependency
   (`!j.accepted`), so the check is dispatched.
4. `cloudByCase` (`runner-service.ts:1151-1154`) only queries m365/entra jobs with
   `status: "succeeded"`. There are none, so the map is empty.
5. The injection falls back to its default `{ immutableId: null, syncEnabled: null, userId: null }`
   (`runner-service.ts:1298`).
6. The runner sees a blank `userId` and takes the first branch
   (`Coretelligent.ActiveDirectory.psm1:1104`): *"no matching Entra object reported — a fresh sync will
   create + anchor it (ok)"*.

That sentence is indistinguishable from a genuine all-clear, and it is emitted precisely when the check
had **no input at all**. This is the spec's stated concern — "it trains operators to ignore it, and a
real inconsistency then goes unnoticed" — with a concrete mechanism.

One more shape the fix must cover: **UM0030327 (core2030)** has m365 `succeeded` but returning no
`UserId`, which lands in the same blank-`cloudObject` state by a different route. Keying on "did we get
usable anchor data", not on the job's status alone, covers both.

### Decisions

1. **Distinguish at the source.** The app knows why there is no anchor; the runner cannot. Carry that
   knowledge in the payload rather than making the runner guess.
2. **Say "could not verify", not "ok".** It is emitted as a WARN so it surfaces on the run report, which
   is the whole point — an unverified hybrid onboard should not read as a pass.
3. **Backward compatible both ways.** A runner that has not picked up the new module ignores the new
   field and behaves exactly as today. A new runner talking to an older app sees no `read` field and also
   behaves exactly as today. Neither half is required to ship first.
4. **Do not change the dependency gating.** Accepting a failure to let a case proceed is a deliberate,
   working feature; the bug is what the check then *says*, not that it ran.

## Global Constraints

- Web + runner, so `runner/VERSION` bumps 1.109.0 → **1.110.0** and the runner needs a deploy.
- Baseline to beat: web **2161 pass / 6 known fail**;
  `Coretelligent.ActiveDirectory.Tests.ps1` at its current pass count / 0 fail.

---

### Task 1: The app says WHY there is no Entra object

**Files:**
- Modify: `web/lib/jobs/runner-service.ts` (`cloudByCase` build ~1148-1167; injection ~1298)
- Test: `web/lib/jobs/cloud-object-injection.test.ts` (new — the logic is extracted to be testable)

**Interfaces:**
- Produces: `export function cloudObjectFor(m365: { status: string; envelope: unknown } | null):
  { immutableId: string | null; syncEnabled: boolean | null; userId: string | null; read: boolean; reason?: string }`
  in `web/lib/jobs/cloud-object.ts`. Task 2's runner branch keys on `read === false`.

- [ ] **Step 1: Write the failing tests**

Create `web/lib/jobs/cloud-object.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { cloudObjectFor } from "./cloud-object";

test("a succeeded m365 result with an anchor is read", () => {
  const out = cloudObjectFor({ status: "succeeded", envelope: { UserId: "u1", OnPremImmutableId: "abc==", OnPremSyncEnabled: true } });
  assert.deepEqual(out, { immutableId: "abc==", syncEnabled: true, userId: "u1", read: true });
});

test("a succeeded m365 result that genuinely found no cloud user is still READ", () => {
  // The check may legitimately report "no cloud object, a fresh sync will anchor it" — but only when
  // we actually looked. That is this case.
  const out = cloudObjectFor({ status: "succeeded", envelope: { UserId: null, OnPremImmutableId: null, OnPremSyncEnabled: null } });
  assert.equal(out.read, true);
  assert.equal(out.userId, null);
});

test("NO m365 job at all is not read, and says so (FR #0000093)", () => {
  const out = cloudObjectFor(null);
  assert.equal(out.read, false);
  assert.match(String(out.reason), /did not run/i);
});

test("a FAILED m365 job is not read, and names the status (FR #0000093)", () => {
  // UM0029901: m365 failed, the operator accepted the failure to let the case proceed, the check ran
  // anyway and reported an all-clear for a comparison it never performed.
  const out = cloudObjectFor({ status: "failed", envelope: null });
  assert.equal(out.read, false);
  assert.match(String(out.reason), /failed/i);
});

test("a SUCCEEDED m365 job whose result carries no anchor fields is not read (UM0030327)", () => {
  // Same blank state by a different route — e.g. a manually-completed step, whose result is
  // { priorStatus, manualCompletion } and carries no UserId.
  const out = cloudObjectFor({ status: "succeeded", envelope: { priorStatus: "failed", manualCompletion: true } });
  assert.equal(out.read, false);
  assert.match(String(out.reason), /no Entra object/i);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd web && npx tsx --test lib/jobs/cloud-object.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Create the module**

Create `web/lib/jobs/cloud-object.ts`:

```typescript
// What the ad-consistency-check step is told about the Entra object, and — when there isn't one — WHY.
//
// The check compares the on-prem source anchor to the Entra object's immutableId. It has no cloud
// credential, so the app reads the anchor from the m365 step's result and injects it. When that read
// yields nothing the check used to be handed a blank object, which it could not tell apart from "there
// is genuinely no cloud object yet" — so it reported the reassuring "a fresh sync will anchor it (ok)"
// line for a comparison it had never performed (FR #0000093). The app knows the difference; the runner
// cannot. So `read` carries it, and `reason` carries the explanation the operator needs.
export type CloudObject = {
  immutableId: string | null;
  syncEnabled: boolean | null;
  userId: string | null;
  read: boolean;
  reason?: string;
};

// The m365/entra job feeding the check: its status and its unwrapped result envelope.
export type M365Source = { status: string; envelope: unknown } | null;

export function cloudObjectFor(m365: M365Source): CloudObject {
  const blank = { immutableId: null, syncEnabled: null, userId: null };
  if (!m365) return { ...blank, read: false, reason: "the Microsoft 365 step did not run on this case" };
  if (m365.status !== "succeeded") {
    return { ...blank, read: false, reason: `the Microsoft 365 step ${m365.status} — its Entra object was never reported` };
  }
  const res = (m365.envelope ?? {}) as Record<string, unknown>;
  const pick = (a: string, b: string) => res[a] ?? res[b];
  const immutableIdRaw = pick("OnPremImmutableId", "onPremImmutableId");
  const syncEnabledRaw = pick("OnPremSyncEnabled", "onPremSyncEnabled");
  const userIdRaw = pick("UserId", "userId");
  // A result that carries NONE of the three keys never looked at Entra at all — a manually-completed
  // step, for instance, whose result is { priorStatus, manualCompletion }. Distinguish that from a
  // step that looked and found no user (userId present but null), which is a real, reportable finding.
  const hasAnyKey = ["OnPremImmutableId", "onPremImmutableId", "OnPremSyncEnabled", "onPremSyncEnabled", "UserId", "userId"]
    .some((k) => k in res);
  if (!hasAnyKey) {
    return { ...blank, read: false, reason: "the Microsoft 365 step reported no Entra object (it was completed by hand, or returned nothing)" };
  }
  return {
    immutableId: typeof immutableIdRaw === "string" ? immutableIdRaw : null,
    syncEnabled: typeof syncEnabledRaw === "boolean" ? syncEnabledRaw : null,
    userId: typeof userIdRaw === "string" ? userIdRaw : null,
    read: true,
  };
}
```

- [ ] **Step 4: Use it in the claim path**

In `web/lib/jobs/runner-service.ts`, replace the `cloudByCase` build (the block starting
`const cloudByCase = new Map<...>` through its closing `}`) with one that keeps the newest m365/entra job
whatever its status, and maps it through the helper:

```typescript
      const cloudByCase = new Map<string, CloudObject>();
      if (checkCaseIds.length > 0) {
        // NOT filtered to succeeded: a failed / manually-completed m365 step is exactly the case the
        // check used to pass silently, and the reason has to reach the operator (FR #0000093).
        const m365s = await db.job.findMany({
          where: { caseRequestId: { in: checkCaseIds }, systemKey: { in: ["m365", "entra"] } },
          orderBy: { finishedAt: "desc" },
          select: { caseRequestId: true, status: true, result: true },
        });
        const best = new Map<string, { status: string; result: unknown }>();
        for (const s of m365s) {
          // Prefer a succeeded one; otherwise keep the most recent (the query is already newest-first).
          const held = best.get(s.caseRequestId);
          if (!held || (held.status !== "succeeded" && s.status === "succeeded")) {
            best.set(s.caseRequestId, { status: s.status, result: s.result });
          }
        }
        for (const id of checkCaseIds) {
          const b = best.get(id) ?? null;
          cloudByCase.set(id, cloudObjectFor(b ? { status: b.status, envelope: jobResultEnvelope(b.result) } : null));
        }
      }
```

Change the injection default so a missing map entry is also honest:

```typescript
            ? { ...casePayload, cloudObject: cloudByCase.get(j.caseRequestId) ?? cloudObjectFor(null) }
```

Add the import:

```typescript
import { cloudObjectFor, type CloudObject } from "./cloud-object";
```

- [ ] **Step 5: Verify**

Run: `cd web && npx tsx --test lib/jobs/cloud-object.test.ts` — all PASS.
Run: `cd web && npm test` — expected 2161 + 5 = **2166 pass**, same 6 known failures.
Run: `cd web && npx tsc --noEmit -p tsconfig.json` — clean.

- [ ] **Step 6: Commit**

```bash
git add web/lib/jobs/cloud-object.ts web/lib/jobs/cloud-object.test.ts web/lib/jobs/runner-service.ts
git commit -m "FR #93 (1/2): the app tells the consistency check WHY there is no Entra object"
```

---

### Task 2: The check reports "could not verify" instead of an all-clear

**Files:**
- Modify: `runner/modules/Coretelligent.ActiveDirectory/Coretelligent.ActiveDirectory.psm1` (~1103-1106)
- Modify: `runner/VERSION`
- Test: `runner/tests/Coretelligent.ActiveDirectory.Tests.ps1`

**Interfaces:**
- Consumes: `cloudObject.read` / `cloudObject.reason` from Task 1.

- [ ] **Step 1: Write the failing tests**

Append to `runner/tests/Coretelligent.ActiveDirectory.Tests.ps1`, inside the describe that covers
`Invoke-CtgADConsistencyCheck` (create one if absent, mirroring the file's existing style):

```powershell
It 'WARNS that it could not verify when the app reports the Entra object was never read (FR #0000093)' {
    $user = [pscustomobject]@{ SamAccountName='jsmith'; UserPrincipalName='j.smith@x.com'
                               cloudObject = [pscustomobject]@{ immutableId=$null; syncEnabled=$null; userId=$null
                                                                read=$false; reason='the Microsoft 365 step failed — its Entra object was never reported' } }
    $r = Invoke-CtgADConsistencyCheck -User $user -Config ([pscustomobject]@{})
    ($r.Actions -join ' ') | Should -Match 'WARN'
    ($r.Actions -join ' ') | Should -Match 'could NOT verify'
    ($r.Actions -join ' ') | Should -Match 'Microsoft 365 step failed'
    ($r.Actions -join ' ') | Should -Not -Match 'a fresh sync will create'
    $r.Flagged | Should -BeTrue
}

It 'still reports the genuine no-cloud-object case as ok when the app DID read it' {
    $user = [pscustomobject]@{ SamAccountName='jsmith'; UserPrincipalName='j.smith@x.com'
                               cloudObject = [pscustomobject]@{ immutableId=$null; syncEnabled=$null; userId=$null; read=$true } }
    $r = Invoke-CtgADConsistencyCheck -User $user -Config ([pscustomobject]@{})
    ($r.Actions -join ' ') | Should -Match 'a fresh sync will create'
    ($r.Actions -join ' ') | Should -Not -Match 'WARN'
    $r.Flagged | Should -BeFalse
}

It 'an OLDER app that sends no read flag behaves exactly as before (backward compatible)' {
    $user = [pscustomobject]@{ SamAccountName='jsmith'; UserPrincipalName='j.smith@x.com'
                               cloudObject = [pscustomobject]@{ immutableId=$null; syncEnabled=$null; userId=$null } }
    $r = Invoke-CtgADConsistencyCheck -User $user -Config ([pscustomobject]@{})
    ($r.Actions -join ' ') | Should -Match 'a fresh sync will create'
    $r.Flagged | Should -BeFalse
}
```

These need the AD lookup mocked the way the file's other AD tests do; reuse the existing
`Get-CtgAdCaseUser` / `Get-ADUser` mock pattern so the resolved user returns an `objectGUID`.

- [ ] **Step 2: Run and watch them fail**

Run: `cd runner && pwsh -NoProfile -Command "Invoke-Pester -Path ./tests/Coretelligent.ActiveDirectory.Tests.ps1 -Output Detailed"`
Expected: the first FAILS (it gets the "(ok)" line); the second and third PASS.

- [ ] **Step 3: Add the branch**

In `Invoke-CtgADConsistencyCheck`, ahead of the existing blank-`userId` branch:

```powershell
    # The app injects `read: $false` when it never obtained an Entra object to compare against — the
    # m365 step failed, was completed by hand, or did not run. That is NOT the same as "there is no
    # cloud object yet", and reporting it as such handed the operator an all-clear for a comparison
    # that never happened (FR #0000093 — the whole reason this check was being ignored). An older app
    # sends no `read` field at all, in which case this is skipped and the behaviour is unchanged.
    $read = Get-CtgProp $cloud 'read'
    if ($read -eq $false) {
        $why = [string](Get-CtgProp $cloud 'reason')
        $actions.Add("WARN could NOT verify the AD/Entra link — $(if ($why) { $why } else { 'the Microsoft 365 step reported no Entra object' }). Nothing was compared, so this is NOT an all-clear: fix the 365 step and re-run it, then re-run this check.")
    }
    elseif ([string]::IsNullOrWhiteSpace($userId)) {
```

(the existing `if ([string]::IsNullOrWhiteSpace($userId)) {` becomes the `elseif` above).

- [ ] **Step 4: Bump the runner version**

```bash
echo "1.110.0" > runner/VERSION
```

- [ ] **Step 5: Verify**

Run: `cd runner && pwsh -NoProfile -Command "Invoke-Pester -Path ./tests/Coretelligent.ActiveDirectory.Tests.ps1 -Output Minimal"`
Expected: all PASS, +3 over the file's current count.

- [ ] **Step 6: Commit**

```bash
git add runner/modules/Coretelligent.ActiveDirectory/Coretelligent.ActiveDirectory.psm1 runner/tests/Coretelligent.ActiveDirectory.Tests.ps1 runner/VERSION
git commit -m "FR #93 (2/2): the consistency check reports what it could not verify"
```

---

### Task 3: Changelog

**Files:**
- Create: `web/lib/changelog/entries/consistency-check-cannot-verify.ts`
- Modify: `web/lib/changelog/entries/_registry.ts`

- [ ] **Step 1: Write and register**

```typescript
import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "consistency-check-cannot-verify",
  date: "2026-08-25",
  time: "10:00",
  title: "The AD/Entra consistency check stops passing what it never checked",
  items: [
    "The check compares the on-prem account's anchor to its Entra object to catch a hybrid onboard that would create a DUPLICATE. When it had no Entra object to compare against, it reported \"no matching Entra object — a fresh sync will create + anchor it (ok)\" — an all-clear for a comparison it had never performed. (FR #0000093)",
    "It now says so: \"could NOT verify the AD/Entra link\", naming why — the 365 step failed, was completed by hand, or did not run — and flags the case instead of passing it",
    "How it happened: the check has no cloud credential, so the app hands it the Entra object read by the Microsoft 365 step. If that step failed and an operator accepted the failure to let the case proceed, the check still ran, was handed a blank object, and could not tell \"there is no cloud object\" from \"nobody looked\"",
    "Correcting the report that filed this: the check was NOT always reporting no match. Of 39 completed checks, 33 reached a real verdict; the 6 that did not are all cases where the 365 step returned nothing. They were concentrated on one client whose 365 step was failing constantly, which is why it looked universal from there",
    "Runner 1.110.0 (Active Directory module) needs deploy",
  ],
};
```

- [ ] **Step 2: Verify and commit**

Run: `cd web && npm test` — expected 2166 pass / 6 known failures.

```bash
git add web/lib/changelog/entries/
git commit -m "Changelog for the consistency check's could-not-verify state"
```

---

## Out of scope, deliberately

- **No change to dependency gating.** Accepting a failure so a case can proceed is a deliberate, working
  feature. The bug is what the check *says* afterwards, not that it ran.
- **No auto-re-run of the check** when the 365 step is later fixed. The operator re-runs the step; the
  existing "Run this step only" path covers it (and is #101's territory if it does not).
- **No hard-match write.** Still detect-only, per the module spec's Design D level 2.

## Risks

- **Newly-loud warnings.** Cases that used to pass silently will now flag. That is the point, but it will
  produce a visible jump on clients whose 365 step fails often — most of which FR #105 has just fixed.
- **Two-sided change.** Web ships on merge, the runner on deploy. Both directions are backward compatible
  and separately tested, so a partial rollout degrades to today's behaviour rather than breaking.
