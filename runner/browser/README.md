# @coretelligent/runner-browser

Browser-automation (Playwright) sidecar for the IAM runner. The runner is pure PowerShell 7 with no
Node runtime of its own; for the few target systems that expose **no API**, the runner shells out to
this Node harness as a last-resort executor. The PowerShell side lives in
`runner/modules/Coretelligent.Browser` (`Test-CtgBrowserAvailable`, `Invoke-CtgBrowserFlow`).

## What it does

`run-flow.mjs` reads a single JSON job spec from **stdin**, runs the named flow against a headless
Chromium, and prints a single JSON result to **stdout**:

```
echo '{ "flow": "spanning-force-sync", "input": { "username": "...", "password": "...", "params": { "email": "user@client.com" } } }' | node run-flow.mjs
# -> { "ok": true, "message": "triggered a Spanning directory sync", "evidence": null, "retryAfterMinutes": 15 }
```

- The password is **never** logged, echoed, or included in the result.
- Any flow failure returns a structured `{ ok: false, error, evidence }` (a screenshot path) instead
  of throwing — the runner maps that to a warning/failure in the run report.
- Exit code is `0` on `ok:true`, non-zero otherwise (the PowerShell side reads stdout regardless).

## Install (per host)

This harness needs Node **and** a Chromium browser binary. From `runner/browser`:

```
npm install
npx playwright install chromium
```

`npx playwright install chromium` downloads the browser Playwright drives — it is **required** and is
separate from `npm install`. Without it, `Test-CtgBrowserAvailable` still reports the harness as
present (node + `node_modules/@playwright` exist), but a flow will fail at launch with a clear
"browser not installed — run `npx playwright install chromium`" error.

Only agents that have completed both steps report the `browser` capability to the app, so the claim
gate withholds browser jobs (e.g. `spanning-force-sync`) from agents without the harness.

## Adding a flow

Drop a `flows/<name>.mjs` that default-exports `async ({ page, input, log }) => result`. `run-flow.mjs`
dispatches on the `flow` field. Keep all portal specifics (URLs, DOM selectors) in clearly-labelled
constants at the top of the flow, marked `VERIFY against the real portal` where they are unconfirmed.
