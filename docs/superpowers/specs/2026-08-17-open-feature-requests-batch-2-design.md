# Open feature requests, batch 2: ranking and per-request plan

**Scope:** the 32 feature requests open on `/feature-requests` as of 2026-08-17 — every row whose
status is still `new`. Each was read against the code it touches, then ordered by production
impact.

**This document is an umbrella,** exactly as its predecessor
(`2026-08-05-open-feature-requests-scaffold-design.md`) was. It fixes the order, records the root
cause found for each request, and defines the per-request workflow. It is deliberately *not* a
design for any one request: each gets its own plan and its own implement → test → changelog →
merge → announce cycle, so a wrong assumption costs one request rather than thirty-two.

## Context

Two things prompted this batch. The 2026-08-05 spec covered fourteen requests; six of those have
since shipped but were never closed on the board, and eight are still open. Since then eighteen
more were filed, most of them by an operator running live cases — so the new arrivals are
overwhelmingly *defect reports about wrong behaviour on real onboards and offboards*, not feature
ideas. That is why this batch is ordered by production impact where the last one was ordered by
implementation effort.

The intended outcome: every one of the 32 reaches a resolved state — `done` with a resolution note
the requester can read, or explicitly parked with the reason recorded — and the two Zoom rooms hear
about each one twice, when scripting starts and when it merges.

### The 32 break down as

| Group | Count | Meaning |
|---|---|---|
| Already built, never closed | 6 | Code shipped; only the status flip is outstanding |
| Carried over from the 2026-08-05 spec | 8 | Planned before, never started |
| Newly filed since 2026-08-05 | 18 | Mostly defect reports from live cases |

Two pairs are the same defect filed twice (#87/#104, #97/#99), so **32 requests resolve through 30
tracked items**: 23 that need code and a PR, 6 that need only a verified status flip, and 1 parked
pending information (#100).

## Decisions taken

Confirmed with the requester before writing this, and binding on every plan below:

1. **Already-built requests are verified, not rubber-stamped.** Each shipping commit is read
   against what the request actually asked for before its status flips. #43 is the standing proof
   this matters — a fix shipped, was announced, and missed the point.
2. **A duplicate pair is one work item and two closures.** Fix the root cause once; flip both
   requests to `done`, each with a resolution note naming the shared fix.
3. **Attribute precedence: the rule wins, and the override is shown.** Where a role/rule sets an
   attribute and the ServiceNow ticket also carries one, the configured rule takes precedence, and
   the run report records that the two disagreed and which value landed.
4. **A non-empty mailbox is never auto-decided.** Whatever the units on screen, if a mailbox holds
   anything at all it stops being treated as trivially convertible and goes to an operator.
5. **#88 corrects in place; it does not delete.** Rename, username, UPN, display name and
   attributes on an account the case already created. No deletion path is built.
6. **Unmodeled steps become real manual jobs,** per the standing rule in `CLAUDE.md` that a job
   whose mode is `manual` is a checklist item on the case and is never silently skipped. An
   untouched one holds the case open.
7. **One PR per request.** 30 PRs, each with its own changelog entry, status flip and chat post.
8. **Ranking is by production impact,** not effort: silently-wrong results first, then
   operator-blocking failures, then correctness gaps, then new capability, then convenience.

## The per-request workflow

Each request, in order. Steps 2 and 7 are the chat posts the requester asked for.

1. Write a plan in `docs/superpowers/plans/2026-08-DD-<topic>.md`.
2. Flip the request to `building` ("Being scripted") and post to chat.
3. Implement, tests first where the unit is pure.
4. `npm test` in `web/`; `Invoke-Pester` for any runner module touched.
5. Add `web/lib/changelog/entries/<id>.ts` plus one id-ordered line in `_registry.ts` — the split
   file convention exists precisely so concurrent PRs do not collide on it.
6. Branch, commit, push, PR, merge via `scripts/prs.sh <n>`.
7. Flip to `done` with a resolution note, and post the changelog entry to chat.

Statuses move `new → planned` (all 32, on approval of this spec) `→ building` (as each is picked
up) `→ done`. `FR_STATUSES` in `web/lib/feature-requests/status.ts` is the only vocabulary; the
board renders `building` as "Being scripted" and `done` as "Implemented".

### Mechanics that already exist and are reused

Nothing new is built for the workflow itself:

- **Status flips:** `npx tsx web/scripts/fr-status.ts <number> <status> --note "…"`, addressed by
  the number operators quote. It arms the 7-day archive timer through the same
  `frHideAtOnStatusChange` the triage panel uses, and audits as `script:fr-status`. `--dry-run`
  first.
- **Chat destinations:** `AppSetting["failure_notifications"]`. Verified against the live database
  on 2026-08-17: **Zoom is the only enabled channel**, and both the `default` (all-clients) and
  `restricted` rooms have a saved URL + token, with the `announcement` event on. Teams, Slack and
  email are all disabled on both sides. So `--audience both` reaches exactly the two Zoom rooms the
  requester means.
- **Posting:** `npx tsx web/scripts/announce-merged.ts --pr <n> --audience both`, which resolves
  the changelog entry ids from the PR's own diff and sends through the same composer and sender the
  "Send to chat" button uses. `--dry-run` resolves everything and sends nothing. `scripts/prs.sh`
  already calls it after a successful merge.

**The step-2 "starting to script this" post is the one gap.** `announce-merged.ts` posts changelog
entries, which do not exist yet at that point, and the per-request `POST
/api/admin/feature-requests/[id]/announce` route deliberately refuses non-human senders. That guard
is what stands between a scripted mistake and a message in real customer rooms, and **this batch
does not weaken it**. The step-2 posts therefore go out through the existing "Send to chat" button
under a real global-admin session, with the composed text supplied as the comment. If genuinely
unattended announcement is wanted, that is its own feature request, not a change smuggled into an
unrelated PR.

## Tier 0 — already built; verify and close (6 requests, no new code)

Five are merged to `main`; #84 is on `fr-84-multiple-delegates` and closes only once that branch
merges. For each: read the shipping commit against the request text, confirm it satisfies the ask,
then `fr-status … done --note "…"` and announce.

| # | Title | Shipping commit | On main |
|---|---|---|---|
| 45 | Cases — Assigned to | `90c8f21` | yes |
| 46 | Cleaner notes for Case | `d2ae171` | yes |
| 47 | Offboardings — out-of-office never applied | `d1fa3c4` | yes |
| 80 | Backbones and password resets | `fbd1259` | yes |
| 82 | Six One Commodities | `bd96e9a` | yes |
| 84 | Delegation of mailboxes | `e4735ea` | **no** |

Verification is not a formality. #45 shipped as "who opened the case" against a request that said
"who each case is assigned to", and the app has no assignment model — if that reading was wrong,
the request reopens rather than closing quietly.

## Tier 1 — silently producing wrong results on live cases

These change what lands in a customer's directory without anyone being told. They come first
because the cost of leaving them is a wrong user record that nobody knows is wrong.

### 1. #104 + #87 — role/rule attributes are never applied on the M365 lane

The single worst item in the batch: every attribute rule authored in the UI for a cloud client is
silently ignored, so operators believe they have configured something that does nothing. #87's body
is empty; #104 supplies the detail (Breakthrough Energy Ventures — title, department, location
configured, none applied). One fix, both closed.

Root cause, already located: `Coretelligent.M365.psm1` builds a **hardcoded ten-field** map from
the intake and never reads `$Config.attributes`. The AD module does exactly that, generically, via
`Set-CtgADAttributes`. `profiles/_schema.json` promises the generic behaviour for both lanes; on
the M365 lane the promise is unmet.

Work: mirror the AD pattern in the M365 module, and add `offboardAttributes` parity. Per decision 3,
the rule value wins over the intake value and the run report records the disagreement. Two existing
behaviours must survive: the AD-synced on-prem-mastered path that reports a clean skip rather than
an error, and the `$hasVal` guard refusing empty values and unresolved `{token}` strings. Web +
runner, so this needs a version bump and a runner deploy.

### 2. #90 — roles are not read from the ServiceNow case

If roles never arrive, every downstream role-driven decision — groups, licences, attributes — is
made on incomplete input, and the case still reports green. Diagnose in
`web/lib/servicenow/intake-mapper.ts` (whether the field is captured) and then
`web/lib/cases/planning-service.ts` (whether it reaches the plan). The precedent is exact: #47 was
a field captured at `intake-mapper.ts:292` and referenced nowhere else. Check for the same shape
first.

### 3. #99 + #97 — requested mail forwarding is never applied

Confirmed by search: `Coretelligent.Exchange.psm1` implements forwarding
(`ForwardingSmtpAddress`), and **nothing in `web/lib` plans a forwarding step from the case**. Same
captured-and-dropped shape as #47, whose fix was a plan-time injection in
`web/lib/profiles/plan-resolve.ts` — structurally the model here, and web-only if it holds. One
fix, both closed.

### 4. #91 — edited fields do not re-run rules and roles

An operator corrects a field on the case, the rules keep firing on the original ticket value, and
the correction silently does not take. `web/lib/cases/replan-service.ts` and
`replan-payload-merge.test.ts` are the seam; `replan-rederive-neverrun-mode` shows the established
pattern for re-deriving on replan.

### 5. #93 — ad-consistency-check always reports no matching Entra object

A consistency check that always says "no match" is worse than no check: it trains operators to
ignore it, and a real inconsistency then goes unnoticed. Spec at
`docs/modules/ad-consistency-check.md`; likely a matching-key mismatch (UPN vs mail vs
`onPremisesImmutableId`) rather than a missing permission — confirm before fixing.

### 6. #105 — AD-synced clients still create 365 accounts instead of adopting

**This is a regression, not new work.** Adopt-only for AD-synced clients shipped 2026-07-22
(`ad-synced-adopt-only`, plan at `docs/superpowers/plans/2026-07-22-ad-synced-adopt-only.md`),
and #105 was filed 2026-08-16 against core2030 saying it still creates. Ranked high because the
failure mode is a duplicate cloud account for a real person.

Diagnose first, in this order: is core2030 actually flagged AD-synced; is `allowCloudCreate` set on
its M365/Entra config; does the adopt path in `web/lib/profiles/plan-resolve.ts` and
`web/lib/jobs/runner-service.ts` still run. The fix follows the finding — it may be client
configuration rather than code, which is itself the resolution note.

### 7. #42 — child companies pull groups from the case but never add them

Carried over. Root cause is not confirmable from code alone: FR#4 routes requested groups to the
lane that *masters* them, so a child whose systems differ from its parent's can have groups handed
to a lane it does not run. Diagnose against the reported case (`cms3j3vm200pg7qevdjlvkbdc`), then
fix. May collapse into #41, so it is sequenced after it.

## Tier 2 — an operator is blocked mid-case

Loud rather than silent, but work stops until someone intervenes by hand.

### 8. #94 — "Insufficient Rights" on Magma and UOVO offboards

Diagnose from the failed cases: pull the actual job errors and audit rows, identify the exact
missing Graph permission or AD right, then fix. `web/scripts/audit-m365-graph-perms.ts` already
pivots gaps by permission across the fleet and is the right first instrument. Whatever the cause,
the error text must end up naming the missing permission — "Insufficient Rights" alone is not
actionable.

Worth carrying into this one: while probing ServiceNow for #100 I hit
`403 Insufficient rights to query records` on a field-level ACL against the integration account. A
field ACL, not a role, is a live possibility here too.

### 9. #101 — "Run this step only" pauses the case and does nothing

The feature exists and has been hardened twice (`web/lib/jobs/run-single.ts`, with the paused-case
override at `runner-service.ts:839` and the no-cascade rule at `:1020` and `:1936`). So the pause
half works and the dispatch half does not. Trace the job from reset to claim: most likely the reset
job is not visible to the claiming runner, or `singleRun` is lost across the hand-off.

### 10. #96 — unmodeled module steps vanish instead of becoming manual work

Per decision 6, an unmodeled step becomes a first-class manual job, tickable in the Run Report, and
holds the case open until ticked or waived. `web/lib/clients/runbook-extract.ts` already identifies
unmodeled steps; the work is carrying them into the plan as `manual` jobs rather than dropping
them, then rendering them in `web/app/cases/_components/run-report-view.tsx`.

### 11. #92 — a taken username fails instead of offering to adopt

Refines the picker that `ad-synced-adopt-only` already built. Today a name collision can hard-fail;
the request is that when display name *and* email both match the case, the operator is always
offered Adopt. Sequenced after #105 because both touch the same decision path and #105 may move it.

## Tier 3 — correctness gaps: right result, wrong or missing controls

### 12. #95 — Spanning destructive offboards should drop the licence, not convert to Archive

Most clients have no Archive licensing, so the convert attempt fails on a step marked destructive.
Spec at `docs/modules/spanning.md`. Behaviour change on a destructive step, so it stays inside the
existing `requiresApproval` gating.

### 13. #85 — small mailboxes treated as empty

Carried over, and decision 4 settles the question the last spec was blocked on. Cause:
`ConvertFrom-CtgMailboxSize` rounds bytes to two decimals of a GB, so anything under roughly 5 MB
reads `0.00 GB`, and `canConvert` treats a real `0` as known-and-convertible by design. Under
decision 4 the fix is not a better rounding threshold but a rule: a mailbox holding anything at all
is surfaced for an operator decision rather than auto-converted. `web/lib/cases/mailbox-decision.ts`
is the seam, and it is pure and already tested.

### 14. #41 — roles and personas should reach child clients

Carried over. `clientForPlanning` (`web/lib/cases/repository.ts:159`) does fall back to the parent
for `personas`, `globals`, `globalsOffboard`, `locations` and `identity` — but only when
`c.systems.length === 0 && c.parentId && c.inheritParentSystems`. Any `ClientSystem` row of its own
disables the whole block, so a child whose systems were copied down (which `copyParentModeling`
does deliberately) inherits no personas. That is exactly the reported behaviour.

The request also asks for "the option to remove them if necessary", so this needs an explicit
inheritance model with a per-child opt-out mirroring `inheritParentSystems`, not a second
mechanism. Schema + planner + UI; must not contradict the existing `reset-child-to-parent` feature.

### 15. #89 — multiple email domains cannot be chosen on an AD-synced client

`web/lib/servicenow/email-domain.ts` exists and `Client` carries `primaryDomain`, `domains[]` and
`emailDomain`, so the data is modelled; what is missing is an operator choice at case level.
Distinct from #83 — this is the *mail* domain, #83 is the *AD* namespace.

### 16. #83 — no way to specify the AD domain name

Carried over, and still ranked below its tier-mates for the same reason as last time: it lands in
identity derivation, the code that produces every username and UPN for every client. There is no
AD-domain field anywhere — the AD module derives it live from `(Get-ADDomain).DNSRoot`
(`Coretelligent.ActiveDirectory.psm1:67`), so an `ad_standalone` client whose AD namespace differs
from its mail domain (Olympus Cosmetic / `syee.local`) cannot express that. Behind tests, with the
blast radius mapped before any edit.

### 17. #103 — SCIM systems should not offer credential wiring

SCIM needs no credentials, so offering a wiring panel invites an operator to configure something
meaningless and then wonder why it is untested. Mode already exists in `web/lib/clients/types.ts`;
the work is suppressing the wiring affordance and the connection test for that mode.

### 18. #102 — a published custom connector never appears in the client systems list

The connector builder writes a `SystemCatalog` row on publish (`web/lib/connectors/definition.ts`,
`repository.ts`), so trace publish → catalog row → the systems listing's query. Most likely the
listing filters to a known module set that a published connector does not join.

## Tier 4 — new capability

### 19. #88 — correct a user the ticket got wrong

Per decision 5: rename, username, UPN, display name and attributes on an account the case already
created, across every system the case touched. **No deletion path.** The change machinery already
exists — `web/lib/cases/change-plan.ts`, `change-service.ts`, `change-types.ts` — so this is
plausibly a new change *action* over existing rails rather than a new subsystem. Confirm that
before designing.

### 20. #81 — select the Google OU on onboard and offboard

Carried over. The runner is already there: `Coretelligent.GoogleWorkspace` honours `config.ou`
(defaulting `/Active Users`, refusing Root) and `config.inactiveOu`, and the OAuth scope list
already requests `admin.directory.orgunit`. Missing is discovery and a picker — Google OUs are not
enumerated into `Client` the way `adObjects` and `cloudGroups` are. Mirror that shape (a
`…RequestedAt` flag the runner consumes, results posted back) and reuse the `ad-folder-tree-picker`
UI pattern.

### 21. #86 — surface a client's default password

Carried over and half-built: `profiles/_schema.json:62-63` defines
`identity.password.mode: "shared-default"` with a `sharedSecret` key. Missing is the operator
surface — resolve through the Delinea broker, show it on the case with a copy affordance, audit the
reveal. Inherits the secrets rules: brokered at use time, never persisted into a profile or the
app, reveal is an audited event. Mirror the existing one-time-reveal password flow.

## Tier 5 — convenience

### 22. #43 — the password dialog layout is still broken

Now sizeable, and the diagnosis is uncomfortable. The Run Report imports the **same**
`GeneratePasswordButton` (`run-report-view.tsx:9`, used at `:1127`) that the #29 fix touched — and
that fix was **two lines** (`427f1eb`), narrowing the require-change checkbox and reserving height
on the hint line. The requester confirms it is still a layout/typing problem. So this is not a
different component; it is the same one, insufficiently fixed.

Given a fix already shipped here once and missed, the reporter confirms the specific broken
behaviour against a live browser before this is called done — not after.

### 23. #98 — download the client overview as PDF

`/docs/client-overview`. Straightforward, no dependencies on anything above.

## Parked — not ranked, blocked on information

### #100 — RiskExec cases not showing up

**Investigated and the stated cause is ruled out.** The intake query
(`web/lib/servicenow/intake-list.ts:23`) filters on exactly four things: `active=true`,
`assigned_toISEMPTY`, non-lifecycle subcategory exclusions, and `assignment_group.nameLIKE IAM`.
There is no onshore or onsite clause anywhere in the codebase.

Queried live on 2026-08-17: RiskExec, Inc. resolves cleanly (CORE2108,
`b833764e4710f6903c5e88f4116d43a0`) but has **zero** records on
`sn_customerservice_user_management`, filtered or not. Its only ServiceNow traffic is 13 monitoring
incidents routed to `TEAM-RST-Systems`. Nothing is being excluded, because nothing exists on the
table the poller reads.

Blocked pending a real RiskExec on/offboarding ticket number from the requester, at which point the
poller's treatment of that specific record is traced. Widening the poller fleet-wide is explicitly
**not** done on a hypothesis — that would change intake behaviour across ~200 orgs to chase one.

## Risks

- **Runner deploys.** #104/#87, #95, #85 and #81 change PowerShell modules. Each needs a `VERSION`
  bump and a runner deploy, and each must stay backward-compatible with runners that have not
  updated — the web half ships on merge, the runner half does not.
- **Requests that misname their own cause.** The pattern from the last batch repeated: #100 named a
  filter that does not exist, #82 named PowerShell when it was profile data, #85 named a percentage
  where the code deals in GB. Every "diagnose first" above is there because the stated mechanism
  and the code disagree. None is coded before the cause is confirmed in writing.
- **Regressions among the already-shipped.** #105 and #43 are both reports that a shipped,
  announced fix did not hold. Tier 0's verification step exists to stop a third.
- **Blast radius on identity.** #83, #89 and #88 all touch how usernames, UPNs and mail domains are
  derived. A regression there is wrong accounts at scale, not a cosmetic bug.
- **Chat volume.** 23 code items × 2 posts plus 6 Tier 0 closures is ~52 messages into live
  customer rooms over the batch. Every send is dry-run first, and no send happens without a
  human-confirmed global-admin session.

## Success criteria

- All 32 requests reach `done` with a resolution note the requester can read, or are explicitly
  parked with the reason recorded on the request. #100 is parked today.
- 23 code work items, 23 PRs, each with its own changelog entry, status flip and chat post. The 6
  Tier 0 requests close without a PR — a verified status flip and one announcement each.
- Every merged PR leaves `npm test` no worse than the recorded baseline (see below); no PR is
  credited with fixing a pre-existing failure or blamed for causing one.
- No PR weakens the human-sender guard on chat announcements.
- Anything that turns out to be misdiagnosed is corrected in writing on the request before it is
  coded.

### Test baseline

Measured on this branch (`fr-84-multiple-delegates` at `e4735ea`) on 2026-08-17, before any change
in this batch: **2132 tests, 2126 pass, 6 fail.** The six are unchanged from the 2026-08-05 spec's
baseline at `74cd0a7`, so nothing has regressed in the interim:

- `filter is an AND of per-marker OR branches, each with the null-path branch (not a bare NOT)`
- `the two AND branches target the m365 marker and the google marker respectively`
- `simulated_date is confined to the eggs preview layer`
- `acquireLocalDump: dir and dump present -> no self-heal, plain latest.dump`
- `dbBackupStatus: one projection with defaults filled`
- `field requirements for the newly-added vendors match the runner's required fields`

None are in scope for this batch. They are recorded so no later PR is credited with fixing them or
blamed for causing them.
