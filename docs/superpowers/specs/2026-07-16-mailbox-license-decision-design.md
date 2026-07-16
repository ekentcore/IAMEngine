# Mailbox licence decision — operator buttons on "was NOT converted"

Date: 2026-07-16
Status: approved

## The problem

An offboard whose mailbox was never converted to shared parks forever. The M365/entra
executor keeps the licence (correctly — an unlicensed, unconverted mailbox is purged by
Exchange after its 30-day grace) and emits:

> WARN license KEPT — the mailbox was NOT converted to shared. […] Convert the mailbox
> (or archive the mail), then re-run this step.

For a client with no `convertToShared` configured at all, that advice is a dead end: nothing
in the case will ever convert the mailbox, so every re-run reproduces the identical warning.
Observed on UM0029840 (Easterseals South Florida, core1453): mailbox 2.74 GB — far under the
50 GB cap, so size is not the obstacle — while `ClientSystem(exchange).config.offboard` is
`null`, so `convertToShared` is unset and `Coretelligent.Exchange.psm1:780` skips the convert
block silently. Meanwhile m365's config defers licence removal to entra "after the mailbox is
converted to shared". The two facts contradict: the licence can never come off.

The operator has no way to resolve it from the case. They must hand-edit client config or
hand-convert in EXO.

## The decision

Give the warning three buttons, mirroring the existing `mailbox_oversize` picker:

| Button | Meaning | Outcome |
|---|---|---|
| Convert to shared, then remove the licence | Convert this case's mailbox, then unlicense | mail retained, seat freed |
| Remove the licence — the mailbox will be deleted | Accept the mailbox goes | seat freed, mail destroyed after the 30-day grace |
| Leave the licence and the mailbox | Do nothing, on purpose | mail retained, seat still billed |

**Every answer is a success once finished.** `run-report.ts:248` promotes a succeeded step to
the "warning" verdict solely because an action line matches `/\bWARN\b/`. A decided outcome
therefore drops the WARN prefix while keeping the consequence text in full. This is not new
license: `psm1:1479` already does exactly this for the oversize "keep" answer, with the
reasoning that "a warning that reads like an unresolved problem would send the next person to
decide something already decided". An undecided ask keeps its WARN twin.

### The rule, generalised: a WARN means a human still has to act

Applied to the outcomes that already existed, not just the new ones:

| Outcome | Before | After |
|---|---|---|
| oversize, unanswered | warning | warning (the ask) |
| oversize + remove | **warning** | verified |
| oversize + keep | verified | verified |
| not-converted, unanswered | warning | warning (the ask) |
| not-converted + convert / remove / keep | — | verified |
| client `allowWithoutConvert` | **warning** | verified |
| convert pending | warning | warning |

`oversize + remove` and `allowWithoutConvert` parked their case at "warning" permanently with
nothing left for anyone to do. Both are answered questions — one by the operator on the case,
one standingly by the client's own config — so both now finish green. The consequence text is
unchanged and still lands in the AuditLog row and the ServiceNow work note: a destroyed mailbox
is recorded loudly, it just isn't recorded as an open question.

`convert pending` deliberately keeps its WARN. It is not a decision — it says the Exchange step
hasn't run yet and someone must come back — so a human does still have to act.

### "Deleted" means the 30-day purge, not an immediate hard delete

Removing the licence lets Exchange delete the mailbox when its grace expires. That is the
existing, reversible-for-30-days behaviour and what this button does. An immediate
`Remove-Mailbox` is a different, irreversible executor and is explicitly out of scope.

## Mechanism

### Convert — the DAG already sequences it

`Job.request.dependsOn` for entra is `["m365","exchange"]`, and `blockingJobs`
(`runner-logic.ts:51`) treats any api dependency that is not `succeeded`/`skipped`/accepted as
unmet. So:

1. Write `convertToShared: true` into the **exchange** job's `request.config`.
2. Re-queue exchange **and** entra.
3. The claim gate holds entra until exchange succeeds.
4. Exchange converts (`Get-CtgProp $Config 'convertToShared'` → true) and reports
   `converted mailbox to shared`.
5. At entra's claim, `runner-service.ts:886` computes `mailboxConverted: true` from that
   result; entra removes the licence.

No new orchestration, no new claim-time injection: `requeueJob` preserves `request`, and
runner-service already passes `r.config` through verbatim. This reuses the exact pattern the
`m365-override` route uses today.

### Remove / keep — a new policy key

`mailboxNotConvertedPolicy: "remove" | "keep"` written onto the case's m365+entra jobs.

Deliberately NOT reusing `mailboxOversizePolicy: "remove"`. It would short-circuit the same
guards, but its reason string hardcodes *"mailbox 2.74 GB, over the 50 GB cap"* — false for
this branch, and it would land in an AuditLog row and a ServiceNow work note as a lie.

### Convert is offered only when it can succeed

Exchange refuses to convert when the mailbox size is unreadable (`Exchange.psm1:786`) — it
cannot prove the mailbox is under the cap. The marker carries `sizeGB`; the Convert button
renders only when the size is known and at/under threshold. Otherwise only remove/keep show.

## The marker

```
DECISION_NEEDED:mailbox_not_converted | <message> | sizeGB=2.74 | thresholdGB=50 | convertConfigured=false
```

Emitted at the `psm1:1495` branch alongside its human-readable WARN twin, on a step that stays
`succeeded`. `sizeGB=unknown` when the size could not be read. Parsed by
`parseMailboxNotConverted` in `web/lib/cases/decision-markers.ts`, pinned by a test against
the runner's verbatim string — that test file exists precisely because "the two sides are
bound by nothing but this string".

## Profile follow-up

Per-case decisions never silently rewrite client config. After a successful convert, if the
client's exchange system still has no `convertToShared`, the step offers one Apply button
writing `convertToShared: true` into the `ClientSystem` config, so future offboards convert
by default.

Stateless by construction: the nudge exists exactly while (answered convert) AND (client has
no convertToShared). Applying makes it disappear — no dismissal state to store.

## Components

| Unit | Responsibility |
|---|---|
| `Coretelligent.M365.psm1` | emit the marker; honour `mailboxNotConvertedPolicy`; drop WARN on decided outcomes |
| `decision-markers.ts` | `parseMailboxNotConverted` — the one parser |
| `m365-override` route | validate + write the policy / the exchange `convertToShared`; audit |
| `exchange-convert-default` route | write `convertToShared` to the ClientSystem (profile nudge) |
| `MailboxNotConvertedDecision` | render 3 buttons, confirm-gate the destructive one |

## Error handling

- The route returns 422 when no m365/entra job exists to record the answer on (the existing
  `!n` guard, which exists because selecting only `m365` once iterated zero jobs while still
  returning ok — the answer vanished and the decision came back with nothing to show why).
- Convert additionally 422s when the case has no exchange job to convert with.
- The rerun POST's response is currently unchecked (`run-report-view.tsx:288`), so a 409 shows
  a success-looking UI with nothing queued. Fixed as part of this work.
- Buttons are `case.dispatch`-gated server-side, in line with destructive steps being gated on
  the server and not in the UI.

## Testing

Runner (Pester):
- asks (marker + WARN twin) when not converted and undecided
- never asks twice once answered (`Should -Not -Match 'DECISION_NEEDED'`)
- `remove` removes the licence, names the right reason, and emits NO WARN
- `keep` keeps the licence, emits NO WARN, stops asking
- the oversize reason text is not used for the not-converted branch

Web (vitest):
- `parseMailboxNotConverted` against the runner's verbatim line; `sizeGB=unknown`; em-dash in
  the message; not confused with `mailbox_oversize`
- override route: each policy value, the 422 guards, `case.dispatch` enforcement — the route
  has no tests today
