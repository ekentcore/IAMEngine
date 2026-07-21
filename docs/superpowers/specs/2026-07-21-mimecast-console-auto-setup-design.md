# Mimecast console auto-setup — design

**Date:** 2026-07-21
**Status:** Phase 1 implementing

## Problem

Setting up the Mimecast API 2.0 credential for a client is a manual console visit: an admin
signs into `login.mimecast.com`, creates an API application (role + three products), generates
a show-once Client ID/Secret, and someone copies them into Delinea. We want to eliminate the
whole manual console visit — the runner drives the console, creates the app, harvests the
credential, and vaults it — while keeping the existing manual paste path as the alternative and
the fallback.

## Approach (decided)

Build on the existing runner browser-automation pattern (Google Workspace auto-setup + Spanning
force-sync are the templates): a web dispatcher mints a synthetic single-job case, a runner
`$DISPATCH` executor resolves the brokered console login and shells to a Node/Playwright sidecar
flow, MFA is handled by minting the TOTP at the prompt via the existing `/api/jobs/{id}/credential`
OTP broker, and the web side polls `Job.result`.

**Phased, sign-in first** (the console DOM/MFA is unverified, so we retire the auth risk before
building create-app navigation on top of it):

- **Phase 1 (this build):** prove console sign-in.
- **Phase 2 (later):** create-app navigation + credential harvest + vault + live tracker.

**Sign-in scope:** Phase 1 targets Mimecast-**native** login (email + password + Mimecast's own
TOTP MFA) — the most common case. SSO (M365/other IdP) consoles are a later phase (an M365-SSO
console would reuse the already-hardened `ms-sso-login` flow).

## UX

The existing "Setup Mimecast API" guided modal gains a third tab, **Automatic (browser)**,
alongside **Paste fields** (manual, already built) and **Existing Delinea id**. The manual paste
path is both the alternative and the graceful fallback.

- **Phase 1** adds the Automatic tab with a **"Test sign-in"** button only: it dispatches a
  sign-in-only browser job and reports pass/fail inline (with the runner's screenshot path on
  failure). No tracker table — one job, polled to terminal.
- **Phase 2** adds a **"Run automatic setup"** button in the same tab: sign in → create app →
  harvest → vault, shown in a live step tracker, with fallback to the Paste-fields tab on any
  step it can't complete.

## The `mimecast-console` secret

A **new, persistent per-client** login secret (modeled exactly on `spanning-portal`), distinct
from the `mimecast` API credential:

- Fields: Mimecast admin **email** + **password**. OTP enabled on the Delinea secret itself (the
  runner mints the TOTP at the prompt; TOTP/software token only — push/SMS is an automated
  hard-stop).
- Created in Delinea + wired on the client via the existing secrets panel (same as
  `spanning-portal`). The Automatic tab's "Test sign-in" route returns a clear "wire a
  `mimecast-console` secret with OTP; see /help/mimecast" message when it isn't wired, so the
  modal needs no server-provided wired flag.
- **Not** in the value-probe registry — a browser login can't be cheaply API-probed; the browser
  sign-in test *is* its test.

## Phase 1 — components

One ad-hoc systemKey serves both phases: `mimecast-console-setup`, with `config.signInOnly`
distinguishing the Phase 1 test from the Phase 2 run (exactly like `spanning-force-sync`).

**Web:**

1. `field-requirements.ts` — `mimecast-console` requirements (`admin email`, `password`), synonyms
   mirroring the runner's pick list.
2. `jobs/adhoc.ts` — `MIMECAST_CONSOLE_SETUP_KEY = "mimecast-console-setup"`, added to
   `ADHOC_SYSTEM_KEYS`.
3. `runner/capabilities.ts` — key added to `BROWSER_SYSTEMS` (only browser-capable agents claim it).
4. `cases/exclude-m365-autosetup.ts` — a `MIMECAST_AUTOSETUP_MARKER`, excluded via the same
   OR-with-`DbNull` shape (a bare `NOT` on a JSON path drops null rows — PR #131 regression), and
   AND-ed into `notM365AutoSetupCase` so the synthetic case is hidden from /cases + bulk-replan.
5. `dispatch-mimecast-console-job.ts` — mints the synthetic onboard/api case (flagged with the
   marker) + a `singleRun` Job with `systemKey: mimecast-console-setup`,
   `secretNames: ["mimecast-console"]`, `config: { consoleUrl, signInOnly: true }`. No
   `secretOverrides` — it's a persistent client secret resolved by the normal broker.
6. `app/api/clients/[slug]/mimecast-console/signin-test/route.ts` — `POST` dispatches (refusing
   with a clear message when `mimecast-console` isn't wired) and returns `{ jobId }`; `GET
   ?jobId=` reports `{ done, ok, error, evidence }` off the job status/result. The modal polls GET.
7. `api-setup-catalog.ts` — an `autoBrowser?: "mimecast-console-setup"` flag on the mimecast entry;
   the modal renders the Automatic tab only for entries that declare it.
8. `guided-api-setup.tsx` — the Automatic tab (Phase 1: explanatory text + "Test sign-in" button
   that dispatches + polls + shows the verdict/evidence).

**Runner:**

9. `Start-IamRunner.ps1` — `$DISPATCH['mimecast-console-setup']` (Onboard = Offboard) resolving the
   `mimecast-console` secret and passing `-OtpRequest` for the credential endpoint.
10. `Coretelligent.Mimecast.psm1` — `Resolve-CtgMimecastConsoleLogin` (email/password pick, Pester-
    tested) + `Invoke-CtgMimecastConsoleSetup` (Phase 1: `signInOnly`), shelling to
    `Invoke-CtgBrowserFlow -Flow 'mimecast-console-signin'`. Export both in the `.psd1`
    `FunctionsToExport` (manifest drift hides them otherwise).
11. `runner/browser/run-flow.mjs` — `mimecast-console-signin` in the `FLOWS` map.
12. `runner/browser/flows/mimecast-console-signin.mjs` — native Mimecast login (email → password →
    TOTP via `mintOtp`), `onActiveView`/`waitForCondition` hidden-element discipline, OTP scrubbed
    before any evidence screenshot, success = a known post-login element. `signInOnly` stops there.
    **LIVE-VALIDATION PENDING** — selectors are best-effort against the documented console.

**Testing:** unit tests for the secret shape, the ad-hoc/browser gates, the marker exclude, and the
dispatcher job shape; Pester for the login pick logic. The `.mjs` selectors are live-validated
against a real tenant via the Test button.

**Housekeeping:** runner `VERSION` bump (minor); `/help/mimecast` gains the Automatic option + the
`mimecast-console` + OTP setup note; a changelog entry.

## Phase 2 — design (not built yet)

`config.signInOnly: false` runs the full flow as staged progress: **sign in → create app
(idempotent: reuse an existing `iam-engine — <client>` app; else Add API Application → role →
three products) → generate + harvest the show-once Client ID/Secret → vault as the `mimecast`
secret (Automation - API template, resolved by name) → verify (non-blocking API connection test).**

**Rotation (the show-once judgment call):** app absent → create + generate + vault; app present but
nothing usable vaulted → generate (rotate) + vault (the prior secret is unrecoverable); app present
and a working `mimecast` secret already vaulted → skip generate, just confirm. Mirrors
`write-m365-app`'s kept-valid-vs-stranded logic.

**Harvested-credential egress:** the Client ID/Secret ride only the single stdout result line
(never logs/WARN/screenshots), and the web core vaults them immediately.

**Tracker:** a lightweight `MimecastConsoleSetupRun` table (one live run per client, staged progress
polled by the modal), mirroring `GoogleSetupRun`.

**Fallback:** any stage that can't complete → screenshot + stop; the modal shows "stopped at
*stage*" and points to the Paste-fields tab.

## Constraints carried forward

- Runs on the **central runner** (Mimecast is cloud), browser-capable — same host as Spanning
  force-sync.
- Console login passes by name; harvested API creds (Phase 2) are secret-on-the-result-line only.
- MFA is TOTP/software only; push/SMS is an automated hard-stop with a screenshot.
- Web-await and runner `-TimeoutSeconds` kept in step.
- Whatever the `.mjs` does can't be trusted until live-validated, and Mimecast can change its UI —
  the manual paste path is a permanent fallback, not a temporary one.
