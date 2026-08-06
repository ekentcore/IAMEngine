# Open feature requests: implementation scaffold and ordering

**Scope:** the 14 feature requests open on `/feature-requests` as of 2026-08-05 (all status
`new`; none were `planned` or `building`). Reviewed against the code each one touches, then
ordered by implementation effort — easiest first, per the requestor's instruction.

Thirteen are ranked and sequenced below. The fourteenth, **#0000043**, is deliberately not
ranked — it reports that a previous fix misunderstood the request, so it cannot be sized from
code. See *Risks*.

**This document is an umbrella.** It fixes the order, records the root cause found for each
request, and defines the per-feature workflow. It is deliberately *not* a design for any one
feature: each gets its own spec and its own implement → test → changelog → push → announce
cycle, so a wrong assumption is caught in one feature rather than fourteen.

## Why effort order, not value order

Confirmed with the requestor. Two reasons it holds here: several of the "easy" items are
pure functions with no runner deploy (so they ship the same day they're written), and four of
the fourteen turned out to be *misdiagnosed* in the request text. Working cheapest-first
surfaces those corrections early, while the cost of being wrong is a few lines.

## The per-feature workflow

Each feature, in order:

1. Write a short spec in `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`.
2. Ask the requestor any question whose answer changes the work. **Blocking**, not advisory —
   four of these have a genuine fork in them.
3. Implement, tests first where the unit is pure.
4. `npm test` in `web/`, plus `Invoke-Pester` for any runner module touched.
5. Add `web/lib/changelog/entries/<id>.ts` and one id-ordered line in `_registry.ts`
   (the split-file convention exists precisely so concurrent PRs don't collide).
6. Branch, commit, push, PR.
7. Post the update to chat, signed **"automatic update by Claude AI"**.

### Constraint on step 7

`POST /api/admin/changelog` refuses non-human senders by design:

```ts
if (g.user.system) return NextResponse.json({ error: "sign in required to send announcements" }, { status: 403 });
if (ROLE_RANK[g.user.role] < ROLE_RANK.global_admin) { /* 403 */ }
```

That guard is what stands between a scripted mistake and a message in ~200 client chat
channels, and it is **not** weakened for this work. The send therefore happens through the
existing **Send to chat** button under a real global-admin session, with the composed text as
`comment`. If genuinely unattended announcement is wanted, that is its own feature request
(a service principal permitted to announce) — not a change smuggled into an unrelated PR.

### Test baseline

Six tests fail on clean `main` at `74cd0a7`, before any change here: two `decision-markers`
filter tests, `simulated_date is confined to the eggs preview layer`, two `db-backup` tests,
and `field requirements for the newly-added vendors match the runner's required fields`.
They are recorded so no later PR is credited with fixing them or blamed for causing them.
None are in scope.

## Tier 1 — pure function or config only; no runner deploy

### 1. #0000082 — Six One: "Back Office Users" added to everyone

> There is an onboarding step that is stuck hardcoded into the powershell — Back Office Users
> is a group that should be added on request, not all the time

**The request is wrong about the location, which makes it easier.** Nothing is hardcoded in
PowerShell. It is profile data: `profiles/six-one.json:42` carries `"groups": ["Back Office
Users"]` on the AD onboard lane, i.e. every-user config, and the AD module simply applies the
groups it is handed.

Work: move the group off the every-user lane so it is added only when requested. Five
assertions in `runner/tests/Coretelligent.ActiveDirectory.Tests.ps1` reference it and must
move with it. Profile change also needs to reach the seeded `ClientSystem` row.

### 2. #0000046 — Case resolution notes are unreadable

`web/lib/cases/resolution-note.ts` is 46 lines, pure, and **has no test file** — so it is
written test-first. Line 26 is the cause:

```ts
const did = acts.length ? acts.join("; ") : /* … */;
```

Every action for a step is joined onto one line. The requestor supplied a desired output;
distilled, it asks for two changes: one action per line, and dropping low-signal fragments
(`added by the Exchange step (Graph can't)`, `not present yet`). Web-only.

Open question for the requestor: the noise fragments originate in the **runner's** action
strings. Trimming them in the note leaves them in the run log and the audit row, where they
are useful. Confirm the note is the right place to trim.

### 3. #0000080 — Google-backbone clients get their password set in M365

Found in `web/lib/jobs/password-reset.ts`:

```ts
const RESET_SOURCE_ORDER = ["active-directory", "m365", "entra", "google-workspace"];
```

A fixed preference order with `google-workspace` **last**. The comment explains the intent —
"the on-prem-first bias the rest of the app uses for AD-backbone clients" — but the order is
applied to every client regardless of backbone, so a Google client that also has an M365 lane
(common: Google for mail, M365 for Office) has its password reset in the wrong directory.

Work: make the order backbone-aware (`Backbone.google` → Google first). ~10 lines plus tests.
`pickResetSourceJob` already takes the job list; it needs the client's backbone too.

### 4. #0000045 — Cases: "Assigned to" column

**Confirmed with the requestor: this means who opened/imported the case**, not a new
assignment concept. `CaseRequest` already carries `createdBy` (actor-label snapshot),
`createdByUserId` (FK, real operators only) and an index on it. So this is one column in
`web/app/cases/_components/cases-table.tsx` over data already loaded or trivially selected.

Worth stating for the record: the app has **no** assignment model, and the intake poller
imports cases *because* they are unassigned in ServiceNow (`assigned_toISEMPTY`). A future
"real" assignment feature is a separate request.

### 5. #0000085 — Small mailboxes treated as empty

`ConvertFrom-CtgMailboxSize` returns `[math]::Round(bytes / 1GB, 2)`, so any mailbox under
roughly 5 MB becomes `0.00 GB`. `canConvert` then treats a real `0` as known-and-convertible,
deliberately: *"an empty mailbox is exactly the cheapest one to convert, so offer it."* The
two combine to make small-but-not-empty indistinguishable from empty.

**Blocking question.** The request says "below 1% but above 0%". There is no percentage
anywhere in this path — every surface found is GB. Either the requestor is describing a
surface not yet located, or "1%" is informal for "very small". The fix differs, so this is
confirmed before code. Ranked Tier 1 on the assumption it is the rounding; it moves if not.

## Tier 2 — one plumbing hand-off, following an existing pattern

### 6. #0000047 — Out-of-office from the case is never applied

The cleanest diagnosis of the fourteen. `web/lib/servicenow/intake-mapper.ts:292` captures:

```ts
oooMessage: val(r, "u_out_of_office_message"),
```

A codebase-wide search finds **no other reference**. The field is captured and dropped. The
Exchange executor already implements the destination
(`Coretelligent.Exchange.psm1:1116-1119`, `config.autoReply.message` →
`Set-MailboxAutoReplyConfiguration`).

So the work is a plan-time injection in `web/lib/profiles/plan-resolve.ts`, structurally
identical to the FR#7 delegate injection immediately above the insertion point. **No runner
change, no deploy.**

### 7. #0000084 — Mailbox delegation must support multiple users

FR#7 built this for exactly one person and the type says so. `plan-resolve.ts:96` reads a
single string from `payload.provideMailboxAccessTo`; the runner reads a single
`grantFullAccessTo` (`Coretelligent.Exchange.psm1:1085`).

Work: widen to a list on both sides, accepting a bare string for back-compat, and loop the
grant. `oneDriveGrantAccessTo` travels the same path and must widen with it. Web + runner, so
this one needs a runner deploy. Per-delegate failure must stay isolated: one unresolvable
name warns about that name and still grants the others.

Open question: whether the ServiceNow intake field itself can carry multiple people, or
whether the multi-value has to be entered on the case in-app.

## Tier 3 — new config surface plus UI

### 8. #0000086 — Surface a client's default password

Half-built already: `profiles/_schema.json:62-63` defines
`identity.password.mode: "shared-default"` with a `sharedSecret` key. Missing is the operator
surface: resolve the secret through the Delinea broker, show it on the case with a copy
affordance, audit the reveal.

Touches secrets, so it inherits their rules — brokered at use time, never persisted into a
profile or the app, and the reveal is an audited event. The existing one-time-reveal password
flow is the pattern to mirror.

### 9. #0000081 — Select the Google OU on onboard and offboard

The runner is already there: `Coretelligent.GoogleWorkspace` honours `config.ou` (defaulting
`/Active Users`, refusing Root) and `config.inactiveOu`, and the OAuth scope list already
requests `admin.directory.orgunit`.

Missing is discovery and a picker: Google OUs are not enumerated into `Client` the way
`adObjects` and `cloudGroups` are. Mirror that shape (a `…RequestedAt` flag consumed by the
runner, results posted back) and reuse the `ad-folder-tree-picker` UI pattern.

### 10. #0000087 — M365 attribute rules do not work

Root cause found, and it is a real asymmetry between two lanes.

`Coretelligent.M365.psm1:1000-1024` builds a **hardcoded ten-field** map from the intake —
`JobTitle`, `Department`, `CompanyName`, `OfficeLocation`, `MobilePhone`, `StreetAddress`,
`City`, `State`, `PostalCode`, `Country`, plus `BusinessPhones` — and **never reads
`$Config.attributes`**. The AD module does exactly that, generically:

```powershell
foreach ($a in (Set-CtgADAttributes -Identity $sam -Attributes (Get-CtgProp $Config 'attributes') -AdConnection $AdConnection)) {
```

The profile schema promises the generic behaviour for both: *"applied generically (the module
loops and sets each; new attributes need NO module change)"*. On the M365 lane that promise is
unmet, so every attribute rule authored in the UI for a cloud client is silently ignored.

Work: mirror the AD pattern in the M365 module, and add `offboardAttributes` parity. Two
behaviours must survive: the AD-synced on-prem-mastered path that reports a clean skip rather
than an error, and the `$hasVal` guard that refuses empty values and unresolved `{token}`
strings. Precedence between an explicit rule and an intake-derived value needs a decision.

## Tier 4 — inheritance and identity semantics; highest blast radius

### 11. #0000041 — Roles and personas should reach child clients

`clientForPlanning` (`web/lib/cases/repository.ts:159`) *does* fall back to the parent for
`personas`, `globals`, `globalsOffboard`, `locations` and `identity` — but only inside:

```ts
if (c.systems.length === 0 && c.parentId && c.inheritParentSystems) {
```

Any `ClientSystem` row of its own disables the whole block, so a child whose systems were
copied down (which `copyParentModeling` does deliberately) inherits no personas at all. That
is exactly the reported behaviour.

The request also asks for "the option to remove them if necessary", so this needs an explicit
inheritance model with a per-child opt-out, mirroring `inheritParentSystems` rather than
inventing a second mechanism. Schema + planner + UI. Interacts with the existing
`reset-child-to-parent` feature and must not contradict it.

### 12. #0000042 — Child companies pull groups from the case but don't add them

Probably the same family as #41, but **the root cause is not confirmable from code alone.**
The request describes a runtime symptom on one case (`cms3j3vm200pg7qevdjlvkbdc`), and the
relevant path has several plausible failure points: FR#4 routes requested groups to the lane
that *masters* them, so a child whose systems differ from its parent's can have groups handed
to a lane it does not run.

Therefore: **diagnose first** against that case's plan and job configs, then fix. The fix may
collapse into #41. Sequenced after #41 for that reason.

### 13. #0000083 — Specify AD domain names

> This client doesn't use Olympus Cosmetic for email, but since they are AD standalone, they
> use syee.local and there's no way to specify that.

Correct: there is no AD-domain field anywhere. `Client` has `primaryDomain`, `domains[]` and
`emailDomain`; the AD module derives its domain live from `(Get-ADDomain).DNSRoot`
(`Coretelligent.ActiveDirectory.psm1:67`). An `ad_standalone` client whose AD namespace
differs from its mail domain cannot express that.

Ranked last because it lands in identity derivation — the code that produces every username
and UPN for every client. A regression there is wrong accounts at scale, so it goes last,
behind tests, with the blast radius mapped before any edit.

## Risks

- **Runner deploys.** #84 and #87 change PowerShell modules; both need a version bump and a
  runner deploy, and both must stay backward-compatible with runners that have not updated
  (the web side ships on merge, the runner does not).
- **Requests that misname their own cause.** Four of the fourteen (#82 "hardcoded in the
  powershell", #85 "1%", #42 "pulling groups", and #43 below) describe a symptom whose stated
  mechanism does not match the code. Each is confirmed with the requestor before code.
- **#0000043 is not in this plan.** It reads "#0000029 Not fixed — the GUI when clicking
  set/generate password under a system in the Run Report still does not function properly - I
  think the original request was misunderstood." A request that says the previous attempt
  misunderstood it cannot be sized from code; it needs the requestor to say what the button
  should do. Deliberately excluded rather than guessed at, and raised as a question instead.

## Success criteria

- Thirteen ranked features, thirteen separate PRs, each with its own changelog entry and chat
  post. #0000043 is resolved by a conversation with the requestor first, then sized.
- Every merged PR leaves `npm test` no worse than the six-failure baseline.
- No PR weakens the human-sender guard on chat announcements.
- Anything that turns out to be misdiagnosed is corrected in writing before it is coded.
