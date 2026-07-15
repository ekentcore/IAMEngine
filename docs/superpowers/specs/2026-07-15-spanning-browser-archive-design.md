# Spanning offboard: browser-driven Standard→Archive, then verified API rechecks

**Status:** design approved (2026-07-15), pending spec review
**Author:** Claude (with ekent@core.tech)

## Problem

On offboard we want to convert a leaver's Spanning (Kaseya) backup licence from
**Standard → Archive** — keeping their backups but freeing the billable Standard seat.
Kaseya's **API cannot do this conversion**: `POST /users/assign {licenseType:"ARCHIVE"}`
returns `200 {licensed:false}` — a silent no-op — and unassigning to force it *deletes the
backups*. So today every offboard leaves the leaver on a billable Standard seat, and the
runner correctly emits a warning telling a human to archive it by hand in the console
(`Coretelligent.Spanning.psm1:319-341`, PR #67).

The console *can* do the conversion (Manage Licenses → Activate Archived). This feature makes
the runner do that **through the browser** (the action the API refuses), then **verify via the
API** that it took effect, with a bounded schedule of automatic rechecks and an on-demand
"Check now".

## Goals

- Perform the Standard→Archive change via headless-browser automation of the Spanning console.
- Verify success via the API (the existing `Test-CtgSpanningArchived` read-back).
- If the browser change can't be attempted or fails, a **warning is enough** — never fail the case.
- After the offboard step, **re-verify via the API** on a bounded schedule: 15 minutes later,
  then every 3 hours for 3 more checks (four rechecks total). Confirmed at any point → success.
- A **"Check now"** button that verifies via the API immediately **without** consuming a
  scheduled check or shifting the schedule.

## Non-goals

- No change to the API assign path's inability to convert (kept as-is; it self-heals if Kaseya
  ever fixes it).
- No generalisation to other vendors yet (Spanning-specific; built on reusable primitives).
- We never unassign a licence to force conversion (deletes backups) — unchanged.

## Key constraints discovered

1. **Vendor API calls run on runners, not the web app.** The Spanning API credential (`spanning`
   secret) is brokered to a runner at job execution; the web app is only the broker. So every API
   read — including the rechecks and Check-now — must execute as a **runner job**, not a web-side
   sweep.
2. **The browser login is Microsoft SSO and needs a *user-shaped* credential.** The existing
   `spanning-portal` secret is exactly that (an M365 admin email + password, MFA via a Delinea
   One-Time-Password minted at the prompt — seed never leaves the vault). `m365-admin` is an **app
   registration** (client id/secret) and **cannot** drive a Microsoft sign-in box — the code
   deliberately refuses API-shaped creds there (smart-lockout risk). So "fall back to the M365
   credentials" is **not** possible with `m365-admin`. When `spanning-portal` is absent we warn.
3. **The auto-retry loop is the right recheck engine.** `RetryAfterMinutes` → `request.autoRetry.at`
   → `sweepAutoRetries` already implements "ask the vendor again in N minutes," runner-side, capped
   (`MAX_AUTO_RETRIES`), and — since PR #67 — quiet until the final attempt (no per-attempt alert
   spam). Cadence is per-attempt and executor-controlled, so "15 then 180×3" is just what each
   result returns.
4. **The browser flow replays the console's own request.** `spanning-force-sync.mjs` does the
   action by same-origin `fetch()` of the console's API (origin-gated), not by clicking a button.
   The archive flow will do the same — see the HAR dependency below.

## Design

### Offboard step (once, at offboard time) — `Invoke-CtgSpanningOffboarding`

Extends the existing default swap-to-Archive branch (`Coretelligent.Spanning.psm1:309-349`):

1. Find user; already Archive → success (existing idempotency).
2. Try API assign→Archive + re-read (existing). If now Archive → success.
3. Still Standard, and `spanning-portal` wired + `browser` capability available:
   - Run the **new Playwright flow `spanning-archive-license`** (below). Re-read via API.
   - Confirmed Archive → success (line: "archived via console automation").
   - Flow failed (MFA push/number-match, portal error, browser missing) → `WARN` with the
     force-sync-style message + screenshot evidence; continue to step 5.
4. `spanning-portal` NOT wired (or browser unavailable) → skip the browser; `WARN` that includes:
   *"Wire the 'spanning-portal' secret (an M365 admin login, with a Delinea One-Time-Password code
   for MFA) and this archive can be attempted automatically via headless browser."*
5. Not yet Archive → emit the billable-seat `WARN` (kept from today) and **schedule the first
   recheck**: return `Status='ok'` + `RetryAfterMinutes=15`, stamping a marker in the job request:
   `archiveRecheck = { attemptedBrowser: <bool> }` — a flag only. The *count* of rechecks is the
   retry-attempt number the loop already tracks (`request.autoRetry.count`, which survives re-queue
   per the PR #67 fix); we do not keep a second counter.
   Verdict is **warning** (visible — a billable seat), and one `stepWarning` notification fires.

### Rechecks (API-only, on the auto-retry loop)

On each `sweepAutoRetries` re-queue the executor sees `archiveRecheck` and runs an **API-only**
pass (no browser — the user's rechecks are verification, not a re-drive):

- Read `Find-CtgSpanningUser` + `Test-CtgSpanningArchived`.
- **Archive** → `Status='ok'`, verdict **verified**, clear the marker, stop. (This is also how a
  *manual* archive gets auto-confirmed.)
- **Still Standard** → choose the next delay from the retry-attempt number (`autoRetry.count`):
  - offboard step (no rechecks yet) → 15 min
  - after recheck 1, 2, 3 → 180 min
  - after recheck 4 → **stop**: the executor simply returns **no** `RetryAfterMinutes`, so the loop
    ends naturally. Four rechecks total; the warning stands.
- On that final (4th) attempt, send **one** notification: "still on a billable Standard seat after
  rechecks — archive by hand." (No alerts on the intermediate attempts — PR #67.)

The 4-recheck cap is enforced by the executor withholding `RetryAfterMinutes`, so **no change to the
global `MAX_AUTO_RETRIES`** is needed — the cap is entirely executor-controlled, consistent with how
every other vendor-wait sets its own cadence.

### Check now

Button on the Spanning offboard step in the case run report (mirrors `ForceSpanningSyncButton`),
shown while an `archiveRecheck` is pending.

- `POST /api/jobs/[id]/spanning-archive-check` dispatches an **independent one-shot** API-only
  verify job (its own `secretNames:['spanning']`, no `archiveRecheck` marker) — so it never touches
  the parked offboard job's `autoRetry.at`/`count`. The parked recheck schedule is unchanged: no
  scheduled check consumed, no 3-hour shift.
- When that one-shot returns: **Archive** → mark the parent Spanning offboard step **verified** and
  **clear** its pending `autoRetry` marker (cancel the remaining rechecks). **Still Standard** →
  record `lastCheckedAt` for display only; leave the parent's schedule exactly as it was.

### The browser flow — `runner/browser/flows/spanning-archive-license.mjs`

Reuses the `spanning-force-sync.mjs` scaffold verbatim: `launch()` → `page.goto(portal)` → "Log In
with Microsoft" → fill `spanning-portal` username/password → `handleSecondFactor` (Delinea OTP
request minted at the prompt) → KMSI → origin-gated back to the trusted Spanning origin. Registered
in `run-flow.mjs`'s `FLOWS`. Dispatched from a new `$DISPATCH` entry; `spanning-portal` attached via
`wiredOptionalSecrets` (optional-secret invariant honoured).

**Action = replay the captured request** (approved): the console's "Activate Archived" call for the
target user, replayed as an origin-gated same-origin `fetch()` with `credentials:"include"`, exactly
like force-sync's `/api/sync` replay. **Dependency (open):** the exact request (path, method, body
shape, how the user is identified) must be **captured from a HAR** of the Spanning console doing
Manage Licenses → Activate Archived. Until that HAR is provided, the flow cannot be finalised. (A
DOM-driving fallback was considered and rejected in favour of the more robust replay.)

### Credential fallback (resolved)

No `m365-admin` fallback (constraint #2). Absent `spanning-portal` → warn with the "wire it for
automation" hint (step 4). The only credential that drives the browser is `spanning-portal`.

## Data / schema

No new tables. The recheck state rides the existing `Job.request.autoRetry` (which already carries
the attempt `count` and due-time) plus a small `Job.request.archiveRecheck = { attemptedBrowser,
lastCheckedAt? }` flag (JSON, no migration). Check-now's one-shot verify is an ordinary ad-hoc `Job`
(like the force-sync job).

## Error handling

- Browser missing / MFA push / portal error / no portal secret → **warning**, never a throw
  (matches force-sync). Case proceeds.
- API read errors during a recheck → treated as "not yet confirmed"; the schedule continues (does
  not consume extra budget beyond the 4 cap).
- Never unassign to force conversion.

## Testing

- **PowerShell (Pester):** the offboard branch chooses browser-vs-warn correctly by portal presence
  and browser availability; the recheck delay ladder (15 → 180×3 → stop) from `count`; already-Archive
  short-circuit; manual-archive confirmation on a recheck. Mock `Invoke-CtgBrowserFlow`,
  `Find-CtgSpanningUser`, `Test-CtgSpanningArchived`.
- **Node flow:** `spanning-archive-license.mjs` — `signInOnly` path (reuse the force-sync test
  harness), origin-gate rejects a hostile origin, MFA-push hard-stop. (Full replay assertion blocked
  on the HAR.)
- **Web (tsx --test):** `decideAutoRetry`/marker cap at 4; the Check-now route dispatches a one-shot
  that doesn't mutate the parent's `autoRetry.at`/`count`; on Archive it clears the parent marker and
  marks the step verified; verdict stays **warning** while rechecks pend and flips to **verified** on
  confirmation; the final-attempt notification fires exactly once.

## Open items / risks

1. **HAR of the console "Activate Archived" request** — required to finalise the replay flow.
   Blocks only the flow's action step; everything else can be built and tested against a mock.
2. Console MFA that is push/number-match only (not TOTP) is a hard stop for automation → warning +
   manual, same as force-sync.
3. Runner version bump + deploy; `spanning-portal` must have Delinea One-Time-Password enabled.

## Rollout

- Ship behind the existing warning-first behaviour: with no `spanning-portal` and no HAR, behaviour
  is exactly today's (warn + manual) plus the new auto-rechecks and Check-now. The browser attempt
  only engages where `spanning-portal` is wired and the flow is finalised.
