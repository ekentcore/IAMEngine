# FR lifecycle loop — design

**Date:** 2026-07-24
**Status:** approved by Evan (chat, 2026-07-24)

## What this is

An operating procedure (not a product feature) for working the open feature-request
board end-to-end: plan every open FR up front, then implement them one at a time,
flipping each request's status through its existing lifecycle and announcing every
transition to the All clients chat. No new app code is required — the workflow drives
endpoints and conventions that already exist.

## Scope

**In the loop (8):** FR#26, #27, #28, #29, #30, #31, #33, #34.

**Excluded (2):** FR#32 (CVP persona stuck for Every User) and FR#35 (Google
Workspace 400 with creds in Delinea 57051). Both are live-debugging / data fixes, not
scriptable features, and may hit blockers outside our code (client tenant config,
Google-side settings). They stay `new` and are handled separately as support tasks.

## Lifecycle and announcements

Statuses are the existing `FeatureRequest.status` values — no schema change:

| Step | Status | Chat announcement (All clients) |
| --- | --- | --- |
| Planned | `planned` | One-paragraph plan: what will change, where, web vs runner |
| Scripting | `building` ("Being scripted") | High level of what is about to be scripted |
| Implemented | `done` ("Implemented") + `resolutionNote` | What was actually done and how it was verified |

**Mechanics — drive the production app's own APIs** (chosen over a bespoke script or
raw DB writes because these routes already own auditing, the 7-day hide timer, message
composition, and the notification master switch):

- Status flips + resolution note: `PATCH /api/feature-requests/:id`
  `{ status, resolutionNote? }` — requires a `settings.manage` session; writes
  `feature_request.update` audit rows; arms the hide timer on `done`.
- Chat: `POST /api/admin/feature-requests/:id/announce`
  `{ audience: "all", comment }` — composes "Feature request #0000026: …" +
  comment + body + resolution note, and sends via the configured All-clients
  destinations (`lib/notifications/sender`).
- Auth: mint a short-lived `settings.manage` session per the established
  web-dev-verify recipe (session row in the shared DB + cookie) and call the endpoints
  with it. Sessions are revoked/expired when the loop ends.

**Ordering within a transition:** flip status first, announce second. A chat-send
failure never blocks or reverts a status flip.

**Preflight:** the first Planned announcement doubles as the webhook proof. If the
announce endpoint reports nothing was sent (master switch off, no destinations
enabled), stop the loop and report — do not keep flipping statuses silently.

## Phase 1 — planning pass (all 8 before any implementation)

For each FR, in number order: read the full request, inspect the relevant code, and
write a concrete mini-plan (what changes, which files/lane, web-only vs runner,
test approach, rough size). Then flip to `planned` and announce with the plan summary
as the comment. Output: one implementation-plan document covering all 8 (produced via
the writing-plans skill after this spec is approved).

The 8 requests, as filed:

- **#26 Fleet setup** — `/tools/fleet-m365` sweep must exclude clients marked as
  having no runner (e.g. Dianthus).
- **#27 Offboardings – shared mailboxes** — if the mailbox is *already* shared, the
  runner must still remove licenses; today it assumes "I didn't convert it, so it
  wasn't converted" and keeps the seat.
- **#28 Locations** — inactive locations must not be pulled for clients.
- **#29 Password reset GUI** — the reset works but the GUI breaks when changing the
  password (visual bug, reproduce on `/clients/v3`).
- **#30 Onboarding** — case fields should accept additional groups beyond the list
  the engine planned.
- **#31 Onboarding – passwords** — allow a password reset before the engine runs,
  since imported cases pause.
- **#33 Custom commands** — Logicsource needs
  `Add-MailboxFolderPermission -Identity <user>:\calendar -User calendar.delegate.reviewer@… -AccessRights Reviewer`
  run for every onboarded user — a per-client custom Exchange command step.
- **#34 Mailbox auditing for CVP clients** — implement the CVP Exchange step from the
  documented Exchange Online script.

## Phase 2 — implementation loop (easiest first)

Order: **#28 → #26 → #29 → #31 → #30 → #27 → #34 → #33** — quick web-only fixes
first for early visible wins, runner-side and framework-shaped work last.

Per FR:

1. Flip to `building` + announce the high-level scripting plan.
2. Implement in its own worktree: TDD, commit-review-commit cadence, bump
   `runner/VERSION` when runner code changes.
3. Verify: web + Pester test suites green; changelog entry appended
   (one-file-per-entry, Eastern time on a 15-minute boundary, registered in
   `_registry.ts`).
4. Open the PR and merge via `prs.sh`; release the worktree.
5. Flip to `done` with a `resolutionNote` + announce what was actually done and how
   it was verified.

**Done gate (decided):** Implemented = merged to main with tests green. Web changes
ride the push-to-main auto-deploy; runner changes are noted in the resolution and the
announcement as "takes effect with the next runner deploy."

## Error handling

- **Unexpected blocker mid-scripting** (external config, missing access): post what
  was found to chat, set the FR back to `planned` with a note of what's needed, and
  continue with the next FR.
- **Announce endpoint reports nothing sent:** stop and report (see preflight).
- **A merge/test failure** is handled inside that FR's cycle (fix or park); it never
  flips to `done` without green tests and a completed merge.

## Testing this workflow

The workflow itself is exercised by its first transition (FR#28 → planned +
announcement observed in the All clients room). Each FR's code change carries its own
tests per the repo's conventions.
