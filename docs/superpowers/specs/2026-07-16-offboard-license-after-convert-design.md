# Offboard: remove the M365 license after the mailbox converts to shared

Status: implemented
Date: 2026-07-16
Related: PR #67 (`spanning-archive-not-convertible`, the last billable-seat leak), PR #90 (Graph cap probes)

> **Revision note.** The first draft of this spec proposed a cross-step `autoRetry` re-queue: let the
> license step run first, then re-queue it once Exchange converted. A high-effort review killed it, and
> it is recorded here because the reasoning matters:
> * the loop guard was **unimplementable** — it keyed on `autoRetry.reason`, a field the marker type
>   does not have and the requeue path strips (`carriedRetryMarker` returns only `{count, firstAt}`),
>   and `decideAutoRetry` deletes the marker outright when the job posts its result. It would have
>   re-queued unbounded, and the "fires once" test would have passed against nothing.
> * the stamp would have **hidden the leak it failed to close**: `run-report.ts:315` rewrites
>   `warning → retrying` on any `autoRetry.at`, and `repository.ts:585` excludes retry-stamped jobs
>   from `warningsByCase` — so "WARN license KEPT" would have stopped blocking green-done. A leaked
>   seat would render as a green case: strictly worse than today.
>
> The real defect was upstream, and fixing it removes the need for any re-queue.

## Problem

Every offboard for a client that converts mailboxes to shared leaves a **billable M365 seat assigned
forever**.

Evidence — case UM0029796 (Apollon Wealth / `core2030`, offboard of Sydney Zurbrinsky, 2026-07-15):

| time | step | outcome |
|---|---|---|
| 22:01:37 | `entra` | `WARN license KEPT — this client converts the mailbox to shared and that step hasn't run yet … Re-run this step once the mailbox step is done` |
| 22:03:33 | `m365` | `license kept here by design — it is removed in the entra step, after the mailbox is converted to shared` |
| 22:04:58 | `exchange` | `mailbox size: 0.05 GB`, **`converted mailbox to shared`** |

The mailbox converted at 0.05 GB, nowhere near the threshold. The license step ran **three minutes
earlier**, correctly refused to strip a license off an unconverted mailbox, asked to be re-run, and
**nothing ever re-ran it**.

### Root cause

`IDENTITY_PIPELINE` (`orchestrator.ts`) is an **onboard** chain: create in AD → directory-sync → cloud
consumers, with `exchange` last, because a new mailbox needs its license first. `identityPipelineDeps`
applied it to offboards too — where the order is exactly reversed: the mailbox must be converted to
shared **while the account still holds its license**.

The runtime guard in `Coretelligent.M365.psm1` then did its job (keep the license, warn, succeed), but
it is terminal: there is **no cross-step re-queue** anywhere in the system. `request.autoRetry` only
ever re-runs a step waiting on its *own* vendor sync.

The planner also **silently discarded the fix the profiles had already written**:
`profiles/coretelligent.json` declares `m365 offboard dependsOn: ["exchange"]` — which
`profiles/_schema.json` documents as the supported way to express exactly this — and
`identityPipelineDeps` filtered that edge out and substituted its reverse. No error, no warning.

## Goals

- After a **confirmed** convert-to-shared, the directly-assigned M365 license is actually removed, in
  a single pass, with no re-queue.
- If the convert was skipped (over threshold, or intent says don't), keep the license and WARN.
- **Never** remove a license unless the *cloud* mailbox is genuinely shared.
- Never claim a fact — a size, a conversion — that was not actually read.

## Non-goals

- **MFA removal / `UserAuthenticationMethod.ReadWrite.All`.** UM0029796 also warned that MFA methods
  were not removed, because Apollon's app registration lacks that permission. Separate problem,
  addressed by the fleet permission-audit report. The step will legitimately keep warning until the
  grant is made.
- **Backfilling already-leaked seats.** This fixes future offboards only. UM0029796's seat is still
  assigned. Finding the existing leaks is the "disabled but still licensed" scanner — separate work.
- Normalising `convertToShared` profile shape drift (the executor now reads all four shapes; the
  profiles are left alone).

## Design

### 1. Order the offboard correctly (`web/lib/orchestrator.ts`)

- `IDENTITY_PIPELINE_ONBOARD` = AD → directory-sync → entra → m365 → exchange (unchanged).
- `IDENTITY_PIPELINE_OFFBOARD` = AD → directory-sync → **exchange** → entra → m365.
- A **universal offboard invariant**, applied to every client and not just on-prem-origin ones: where
  an `exchange` system exists, `entra`/`m365` depend on it, and `exchange` drops any declared edge onto
  them. The drop is also what prevents the two rules from forming a cycle. This has to be structural
  rather than a profile edit: most profiles declare `exchange dependsOn m365` (inherited from the
  onboard lane), and the ~200 seeded clients carry that ordering in the **database**, where editing
  `profiles/*.json` cannot reach them.
- The invariant now requires a **directory-sync**, not merely an `active-directory` system. Identity
  only "originates on-prem" if something pushes it to the cloud. `regal` is ad-standalone — AD runs
  file/print, 365 is provisioned separately, and the profile says so outright — yet the rewrite fired,
  reversed its declared `entra`/`m365` order, and gated its whole cloud offboard behind an AD step the
  profile explicitly disclaims.

With the order fixed, the existing gate passes naturally: exchange converts, the claim-time recompute
reports it, and the license comes off in the same pass. No re-queue, no new mechanism.

### 2. Never claim an unread fact (`Coretelligent.Exchange.psm1`)

- `Get-CtgMailboxSizeGB` returns **`$null`** (unknown) on a failed/unparseable read instead of `0`.
  Zero is a real reading that opens both 50 GB guards; collapsing a failed read into it meant a 200 GB
  mailbox whose size read throttled was converted **and** unlicensed, ending 150 GB over Microsoft's
  unlicensed-shared cap — locked. The convert refuses to run on an unknown size (`$null -gt 50` is
  `$false`, so the comparison alone was not a guard).
- The hybrid path (`Set-RemoteMailbox`) reads the mailbox **back** and only claims a convert once the
  cloud reports `SharedMailbox`; otherwise it WARNs and keeps the license. Uses `Get-Mailbox`
  (`Exchange.ManageAsApp`, already required) — no new permission. A **MailUser** has no cloud mailbox
  to purge and is treated as converted once the on-prem convert succeeds.
- `Test-CtgConvertToShared` reads the **intent** out of all four profile shapes. `if ($cts)` tested the
  object, and every PSCustomObject is truthy, so marketscience's `{ value: false }` — the one shape
  that exists to say "don't" — converted the mailbox anyway.
- The convert block is now gated on `$hasExoMailbox` like every other EXO call in the module.

### 3. Trust only confirmed facts (`web/lib/jobs/mailbox-convert.ts`)

Extracted from `runner-service.ts` so both decisions are testable without a database:

- `isConvertConfirmed(lines)` accepts only the confirmed phrasings. The hybrid line **contains** the
  cloud line as a substring, so a loose match read an unsynced on-prem convert as done. Anything
  unrecognised is "not converted" → license kept: safe by default, including for results written by an
  older runner.
- `isConvertStillComing(status, configured)` is true only while the convert **can** still happen. A
  failed case marks every remaining job `skipped`; calling that "pending" told the operator to re-run
  "once the mailbox step is done" — a state that can never arrive, so the seat billed forever.

### 4. License removal (`Coretelligent.M365.psm1`)

When `Get-MgUser` returns no `LicenseAssignmentStates` (a throttle is indistinguishable from "no
licenses"), the fallback passed **group-inherited** SKUs to `Set-MgUserLicense -RemoveLicenses`, which
Graph rejects — failing the whole offboard step, identically on every retry, so the seat was never
freed and the case could never go green. The rejection is now an expected, reported outcome.

### 5. Run log

No change needed. A `WARN` already flips the step to an amber `warning` verdict
(`run-report.ts:305`), renders orange, blocks a green-done case (`repository.ts:575`), and becomes a
ServiceNow work-note.

Worth recording, because it is what made this invisible: UM0029796's warnings **were** logged. An
operator marked them **"Fixed"** at 21:00 Eastern while closing the case, which sets `resolvedAt` and
hides them from `/runs` — and, via fingerprint inheritance (`runner-service.ts:1583`), pre-resolves
every future identical occurrence. Neither underlying problem was fixed. "Fixed" is a display action
with no verification; that is a separate design question, not addressed here.

## Testing

Web (`npx tsx --test` — node:test, not vitest):
- offboard puts `exchange` before `entra`/`m365`; onboard order unchanged
- `entra`/`m365` depend on `exchange`; `exchange` never depends on them (no cycle)
- a cloud-only client's declared `exchange dependsOn m365` is reordered for offboard
- ad-standalone (AD, no directory-sync): no rewrite, declared order preserved
- offboard with no exchange system: unaffected
- `isConvertConfirmed`: cloud / hybrid-verified / MailUser / already-shared → true; hybrid-pending,
  legacy on-prem line, over-threshold, unknown-size, empty → false
- `isConvertStillComing`: pending/dispatched/running/manual → true; succeeded/failed/skipped → false

Runner (Pester via `~/.local/pwsh/pwsh`):
- `Get-CtgMailboxSizeGB` → `$null` on failed/unparseable/empty identity
- `Test-CtgConvertToShared` across all four shapes, including `{value:false}`
- unknown size → no convert + WARN; `{value:false}` → no convert
- hybrid: cloud reads shared → verified line; cloud still UserMailbox → WARN, no claim
- MailUser with no on-prem session → WARN, no `Set-Mailbox` throw

## Risks / notes

- **Blast radius**: offboard step order changes for every client with an exchange system. `entra`/`m365`
  now run *after* the mailbox convert, so cloud sign-in blocking happens a few minutes later than
  before. For AD-origin clients the AD step has already disabled the account and directory-sync has
  pushed it, so containment is unaffected in practice; for cloud-only clients the change only reorders
  systems the profile already ordered arbitrarily.
- **Two independent thresholds** remain: exchange's `convertToShared.skipIfMailboxOverGB` vs the M365
  gate's `mailbox.sizeThresholdGB`. Both default to 50 but can disagree. Out of scope; worth a
  follow-up.
- **Runner version**: 1.64.0 → 1.65.0. Needs deploy; 1.64.0 was already pending.
- **A client with an exchange step but no `convertToShared`** reports `converted: false`, so the gate
  keeps the license and warns. Pre-existing behaviour, unchanged here, but it is a candidate leak worth
  checking once the scanner exists.
