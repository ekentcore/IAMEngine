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

## ⚠ Needs verification against a real portal

The Spanning **portal login URL** and **DOM selectors** in `flows/spanning-force-sync.mjs` are
best-guess placeholders, in clearly-labelled constants (`SPANNING_PORTAL_URL`, `SELECTORS`) marked
`VERIFY against the real portal`. The flow degrades safely until verified (structured failure +
screenshot, never a false success). To finalize, on a live Spanning admin console:

1. Confirm `SPANNING_PORTAL_URL` (the admin login — **not** the `o365-api-*` API host).
2. Capture the real selectors (e.g. `npx playwright codegen <portal-url>`).
3. Confirm whether the sync completes synchronously or is queued (drives `SYNC_IS_ASYNC` /
   `RETRY_AFTER_MINUTES`).
4. Confirm which **credential** the portal accepts — the API secret stores clientId/clientSecret; the
   admin console login may need a different (O365 admin) credential on the Spanning secret.
5. Confirm the **second-factor type**. If it's app/TOTP, add the authenticator **seed** to the Spanning
   secret (`TOTP` / `OTP Seed` field) and the flow clears it automatically. If it's push/number-match/
   SMS, unattended automation isn't possible — use a TOTP-based automation account or sync manually.

## Adding a new flow

Drop `runner/browser/flows/<name>.mjs` (default-export `async ({ page, input, shot, log }) => result`),
register it in `run-flow.mjs`'s `FLOWS`, add its systemKey to `BROWSER_SYSTEMS`
(`web/lib/runner/capabilities.ts`) and `ADHOC_SYSTEM_KEYS` if ad-hoc, and add a `$DISPATCH` key.
