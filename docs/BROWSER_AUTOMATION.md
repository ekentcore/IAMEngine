# Browser automation (Playwright sidecar)

A last-resort executor path for the **few target systems that expose no API**. The runner is pure
PowerShell 7 with no Node runtime of its own; for these systems it shells out to a small Node +
Playwright sidecar that drives a headless Chromium. First use: **force Spanning sync** (Spanning's API
has no directory-sync endpoint).

## Pieces

| Piece | Path | Role |
| --- | --- | --- |
| Node sidecar | `runner/browser/` | `run-flow.mjs` reads a JSON job spec on **stdin**, runs a flow from `flows/`, prints one JSON result on **stdout**. `lib/launch.mjs` is the shared headless-Chromium launcher (with screenshot-on-failure). |
| Flow | `runner/browser/flows/spanning-force-sync.mjs` | Logs into the Spanning admin portal and triggers a directory/user scan. |
| PowerShell bridge | `runner/modules/Coretelligent.Browser` | `Test-CtgBrowserAvailable` (node on PATH **and** `runner/browser/node_modules/@playwright` present) and `Invoke-CtgBrowserFlow -Flow -InputObject` (shells out, feeds the spec on stdin, parses the result). Never throws — an unavailable sidecar returns `{ ok=$false; error=... }`. |
| Executor | `Invoke-CtgSpanningForceSync` (in `Coretelligent.Spanning`) | Builds the portal login from the brokered Spanning secret + target email, runs the flow, maps the result to the runner's result contract (verified / warning / retry-after). |
| Dispatch key | `Start-IamRunner.ps1` → `$DISPATCH['spanning-force-sync']` | Onboard = Offboard = the force-sync executor. No `Connect` lane (the flow does its own portal login). |

## Install requirement (per host)

The sidecar needs Node **and** a Chromium binary. From `runner/browser`:

```
npm install
npx playwright install chromium
```

`npx playwright install chromium` is **required** and separate from `npm install` — it downloads the
browser Playwright drives. Only when both are present does `Test-CtgBrowserAvailable` return true.

## Capability gate

Browser automation is a **cross-cutting capability**, not an on-prem system. A runner reports the
`browser` capability (alongside its on-prem caps) each heartbeat only when `Test-CtgBrowserAvailable`
is true. On the app side, `browserExclusions()` (`web/lib/runner/capabilities.ts`) withholds
`spanning-force-sync` from **any** agent — central or client — that doesn't report `browser`, so a job
never lands on an agent without the harness (it stays pending with a clear reason). Unlike the on-prem
gate, a legacy/non-reporting agent is also withheld (it definitionally lacks the newer harness).

## Ad-hoc, not case work

A `spanning-force-sync` job rides the Job table but is invisible to the case status/dependency
machinery — see `ADHOC_SYSTEM_KEYS` in `web/lib/jobs/adhoc.ts` (shared with password resets). A failed
sync can't fail the case; a pending one doesn't read as "still running". It's dispatched on demand from
the Spanning step in the run report (`↻ force Spanning sync`), riding the Spanning line's brokered
secret + config, `singleRun` so it can run on a completed/paused case.

## Security

- The password is written only to the child process's **stdin** — never a log, a command-line arg, or
  a temp file. `run-flow.mjs` echoes back only booleans / messages / evidence-screenshot paths.
- A flow failure returns a structured `{ ok:false, error, evidence:<screenshot> }`; the executor maps
  that to a **warning** (a convenience sync must not hard-fail the case).
- **Second factor (MFA):** an **app/TOTP** factor is completed automatically — store the authenticator
  **seed** (the base32 string, e.g. a `TOTP`/`OTP Seed` field) on the Spanning secret and the flow
  generates the current code (`runner/browser/lib/totp.mjs`, RFC 6238, dependency-free). **Push /
  number-matching / SMS / phone** factors can't be automated headless — the flow hard-stops with a
  clear message so the operator syncs by hand (or switches the automation account to app/TOTP MFA).
  The seed and the generated code are never logged.

## Spanning force-sync: what is verified, and what YOU must configure

**Verified against the live console** (and covered by an end-to-end test that drives the real flow
against a fake Microsoft-SSO portal — `flows/spanning-force-sync.test.mjs`):

- The login chain: `SPANNING_PORTAL_URL` → "Log In with Microsoft" → Microsoft 365 SSO → the
  "Stay signed in?" (KMSI) interstitial → redirect back to the console.
- The sync itself. Clicking "Sync" in the console fires exactly one state-changing request, captured
  in a real HAR: `POST /api/sync {}` → `200 {id, status:"PENDING"}`, then the UI polls
  `GET /api/tenantCache/{id}`. The flow **replays that call from inside the logged-in page**, so
  there are no sync selectors to rot — and no token is ever extracted (same-origin fetch reuses the
  page's own session).
- The sync is **async**: still `PENDING` after the poll window is reported as *started*, with a
  recheck window — not as a failure, and never as a false success.

**The one thing it needs from you: the Spanning Delinea secret must carry a PORTAL login.**

1. `PortalUsername` — an **M365 admin's email address**, and `PortalPassword` — that account's
   password. The console is Microsoft 365 SSO, so it needs a real M365 identity. The Spanning **API**
   credential (`clientId` / `accessToken`) **cannot** sign in to the console: it is not an M365
   identity, it produces an unexplained bad-password error, and repeated automated attempts are how
   the account gets locked. The executor now refuses to try (a WARN, never a case failure), and also
   refuses a username that isn't an email — that is almost always an API clientId in the wrong slot.
2. **Enable One-Time Password on that Delinea secret.** The MFA code is minted by Delinea *at the
   moment the prompt appears* — the authenticator seed never leaves the vault. Without it, the flow
   stops at the MFA screen with a screenshot (which is exactly where every attempt died before).
3. The second factor must be **app/TOTP**. Push / number-matching / SMS / phone-call cannot be
   automated headless; the flow hard-stops on those with a clear message so an operator syncs by hand.

Regional consoles (`o365-us`, `o365-eu`, …) are set through `SPANNING_PORTAL_URL`; the origin check
follows whatever you configure rather than a hardcoded host.

## Adding a new flow

Drop `runner/browser/flows/<name>.mjs` (default-export `async ({ page, input, shot, log }) => result`),
register it in `run-flow.mjs`'s `FLOWS`, add its systemKey to `BROWSER_SYSTEMS`
(`web/lib/runner/capabilities.ts`) and `ADHOC_SYSTEM_KEYS` if ad-hoc, and add a `$DISPATCH` key.
