# Triage: the nine requests filed since the 2026-08-17 batch

**Scope:** #106 and #108–#115 — every request that arrived after the batch-2 spec was written and has
therefore never been ranked. Eight of the nine were filed by `ccyr@core.tech` from live case pages
between 2026-08-18 and 2026-08-21; #106 came out of the batch workflow itself.

Each was read against the code and, where it named a case, against what that case actually did. Ranked
by production impact on the same scale the batch-2 spec used: silently-wrong results first, then
operator-blocking failures, then correctness gaps, then convenience.

**The headline: #109 outranks everything left in the batch-2 queue.** It is a live security gap
affecting 43 of 45 AD clients, and it was sitting untriaged.

## Tier 0 — a leaver keeps access

### 1. #109 — offboarding removes no AD groups

> "Steps are not removing user from AD groups"

Confirmed, and far wider than the one case it was filed from. The AD module supports both mechanisms —
`removeAllGroups` (psm1:618) strips everything, `removeGroups` (psm1:656) strips a named list — but
almost nothing is configured to use either:

| AD clients (live) | Count |
|---|---|
| `removeAllGroups` set | **2** |
| named-group rules only | **0** |
| **neither — no AD group is ever removed** | **43** |

core1594, the reported client, has an entirely empty AD offboard config (`{}`).

So on 43 of 45 AD clients a departing employee keeps every AD group membership, and the case reports
green. Group membership is what grants file-share, application and (via group-based licensing) cloud
access — this is the offboard not actually offboarding.

**43 clients did not each make a deliberate choice.** The default is wrong: the profile/seed path never
sets a group-removal policy, so silence reads as "remove nothing". The fix is a safe default plus an
explicit per-client opt-out, not 43 hand edits. Needs a decision on what the default should be
(remove-all vs a protected-group-aware sweep) before any code — `Test-CtgADProtectedGroup` already
exists for the "never strip Domain Admins" rule.

## Tier 1 — silently wrong on live cases

### 2. #115 — requested shared mailboxes are never granted

> "if a case has requested Shared mailboxes, the user should be added with full access"

Confirmed by search, and it is the **fourth** instance of the exact captured-and-dropped shape this
batch keeps finding. `intake-mapper.ts:235` writes `payload.sharedMailboxes` from
`u_shared_resource_mailboxes`; the only other reference in the codebase is its label in
`intake-labels.ts`. Nothing plans it.

Structurally identical to #47 (out-of-office), #84 (delegates) and #97 (forwarding) — all of which were
plan-time-only fixes in `plan-resolve.ts`, all shipped in this batch. The requester notes the
per-client default shared mailboxes work fine, which is consistent: those come from profile config,
not from the ticket.

Cheap and well-understood. Check whether the Exchange module's existing
`Invoke-CtgExchangeSharedMailboxMirror` already provides the destination before designing.

### 3. #111 — the email domain cannot be chosen on a case that needs a non-default one

> "it's not letting me select a different email domain, even though the case is requiring the
> non-default email address"

Filed from UM0030780 (core2030). This is #89 restated from the operator's side — #89 was declined as
"superseded by #112", which on re-reading was the wrong pairing: #112 is the sync-timing request. #89
and **#111 are the pair**, and #89 should be reopened or explicitly folded in here.

The data is already modelled (`Client.emailDomain`, `domains[]`, `primaryDomain`,
`lib/servicenow/email-domain.ts`) and a per-case override exists (`emailDomainOverride`, honoured by
`replanCase`). What is missing is the operator surface to pick it at plan time. Identity blast radius —
this decides every UPN and address on the case — so it needs the same care #83 got.

### 4. #108 — a truncated ServiceNow username cuts off the email, so the mailbox is not offboarded

> "The SNOW contact's Username is too large for the field, which is cutting off the correct email
> address, making the mailbox not able to be properly offboarded."

A truncated identifier that still *looks* valid is the worst input this system can receive: the offboard
proceeds against the wrong address, or fails to find the mailbox, and reports green either way. Needs
diagnosis first — whether the truncation happens in ServiceNow's field, in `refLabel`/`contactEmail`
mapping, or in a column width on our side. UM0030657 (core2104) is the reproduction.

Related to the work already done on `forwardEmailTo` in #97, where the intake stores
`address (sys_id)` and the address had to be extracted — the same field family.

## Tier 2 — the engine fights itself

### 5. #112 — no settle time after the Entra Connect sync

> "the engine is running too fast and the 365 account isn't found because the sync hasn't actually
> finished"

Confirmed: `Coretelligent.DirectorySync.psm1` contains no wait, sleep or poll after triggering the sync
cycle. It fires `Start-ADSyncSyncCycle` and returns, and the m365 step looks the account up immediately.

This is the *other half* of FR #105. That fix stopped the engine mis-reading a synced account as
someone else's; this one is the engine looking before the account exists at all — the
`no synced M365 account for …` failures. Both produce the same operator experience.

Do **not** implement as a flat `Start-Sleep`. The right shape is a bounded poll — wait for the object to
appear in Graph, up to a timeout — which is faster than a fixed delay in the common case and honest
when the sync genuinely has not finished. `Wait-CtgMailbox` in the Exchange module is the existing
precedent for that pattern.

### 6. #113 — AD writeback is assumed absent instead of being checked

> "The runner is assuming all clients don't have AD writeback, while it has the permissions to be able
> to check"

The requester supplied the exact query: `Get-MgDirectoryOnPremiseSynchronization` →
`Features.PasswordWritebackEnabled`. Worth confirming the app-only credential can read it (it needs
`Directory.Read.All` / `OnPremDirectorySynchronization.Read.All`, which is not in the standard permission
set the runner reports) before promising the check — if the permission is missing this becomes a consent
change, not a code change.

Cache the answer per tenant; it is a tenant-level fact that changes ~never, and one Graph call per
password reset would be waste.

## Tier 3 — correctness gaps

### 7. #114 — generated passwords contain characters nobody can type

> "Uncommon characters that can't normally be typed on a keyboard should not be a part of the password
> … like the Euro, Franc"

Real friction: a password an operator must read to a new hire over the phone, or that the hire types on
a non-matching keyboard layout, has to be typeable. The generator's alphabet is the whole change; the
only care needed is not weakening entropy while narrowing the set — lengthen to compensate rather than
silently reducing strength.

### 8. #106 — announce to chat without a human session

Raised out of the batch workflow itself, and its own scope is well specified in the request: a separate
service identity with an explicit announce permission and its own audit actor, saved destinations only,
dry-run mode, and no weakening of the guard on the human-facing route.

**Note the ordering dependency:** the chat webhook is currently returning HTTP 400 to both Zoom rooms
and no announcement has been sent since 2026-08-21. Building unattended posting on top of a broken
transport would ship a feature nobody can observe working. Fix the transport first.

## Tier 4 — convenience

### 9. #110 — the Cases page width is not flexible

Cosmetic, no case attached, no data risk. Lowest of the nine.

## What this changes about the existing queue

The batch-2 remainder was #103 → #102 → #88 → #81 → #86 → #43 → #98. Merging the two lists:

1. **#109** — AD groups not removed (43 clients, security)
2. **#115** — shared mailboxes dropped (4th captured-and-dropped)
3. **#111** (+ reopen **#89**) — email domain not selectable
4. **#108** — truncated username breaks the offboard
5. **#112** — sync settle time (the other half of #105)
6. **#113** — AD writeback detection
7. #103, #102 — the small self-contained ones already ranked
8. **#114** — password alphabet
9. #88, #81, #86 — new capability, as before
10. **#106** — blocked behind the chat transport
11. #43, #98, **#110** — convenience

Six of the nine new arrivals outrank everything left in the batch-2 queue. That is the same pattern the
batch-2 spec found when it re-ordered by production impact rather than effort, and the reason this
triage was worth doing before picking up #103.

## Corrections to the record

- **#89 was declined as "superseded by #0000112".** That is wrong: #112 is sync timing, #111 is the
  email-domain pair. #89 should be reopened or explicitly folded into #111.
- **#100 remains parked**, unchanged — still blocked on a real RiskExec ticket number.
