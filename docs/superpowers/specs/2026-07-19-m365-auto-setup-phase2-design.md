# Automated M365 setup — Phase 2 (browser GA-auth → delegated Graph token) design spec

**Date:** 2026-07-19
**Status:** Brainstorming → build. Phase 2 of the automated-M365-setup program (Phase 1 = the Graph provisioning core, shipped in PR #126). Builds on the same branch.

## Context
Phase 1's `provisionM365App(graphToken, tenant, …)` needs a **delegated Graph token carrying the client's Global-Admin privileges**. Phase 2 obtains it via an OAuth **device-code** flow: the web layer initiates device-code auth against a Microsoft first-party public client for the admin scopes, a headless browser (reusing the existing MS-365-SSO login machinery) completes `microsoft.com/devicelogin` as the GA (TOTP MFA via a Delinea-minted code), and the web layer polls the token endpoint until it receives the delegated token.

## Architecture decision (locked)
- **Device-code flow**, not auth-code (no redirect URI/capture) and not portal-clicking. First-party public client **Microsoft Graph PowerShell `14d82eec-204b-4c2f-b7e8-296a70dab67e`** (device-code-capable, broadly pre-consented), explicit delegated scopes `Application.ReadWrite.All AppRoleAssignment.ReadWrite.All RoleManagement.ReadWrite.Directory Directory.ReadWrite.All offline_access`.
- **Init + poll live in web TS** (co-located with `provisionM365App`; modeled on `acquireGraphToken` in `m365-credential.ts`). The token is produced and consumed in the same process — it never crosses the runner→sidecar stdout boundary (which has a strict field whitelist).
- **The browser leg only signals completion.** It receives the non-secret `user_code`, drives devicelogin + the shared MS-SSO login + MFA + the consent confirmation, and returns `{ok, message:"device login complete"}`. No token rides back.

## Foundations reused (from the exploration)
- MS-SSO login primitives in `runner/browser/flows/spanning-force-sync.mjs` (module-private): `SELECTORS`, `onActiveView` (the aria-hidden SPA gotcha), `waitForCondition`, `mintOtp`, `scrubOtpField`, `handleSecondFactor` (push/SMS hard-stop, TOTP-via-Delinea), plus the inlined login orchestration (username→password→MFA→MS-error-gate→KMSI).
- The sidecar (`run-flow.mjs` `FLOWS` registry, `Coretelligent.Browser.psm1`), the credential broker + OTP minting (`/api/jobs/[id]/credential`, `brokerCredential`, `getOneTimePasswordCode`), the `spanning-portal` interactive-login secret shape, and the `force-spanning-sync` dispatch route + `BROWSER_SYSTEMS` + `$DISPATCH` wiring.

## Components

### A. Web — device-code token acquisition *(testable here)*
`web/lib/secrets/device-code-auth.ts`:
- `startDeviceCode(tenant, fetcher?) → { ok, deviceCode, userCode, verificationUri, interval, expiresIn } | { ok:false, error }` — `POST /{tenant}/oauth2/v2.0/devicecode` with `client_id` + `scope`.
- `pollDeviceCodeToken(tenant, deviceCode, opts, fetcher?) → { ok, token } | { ok:false, error, code }` — `POST /{tenant}/oauth2/v2.0/token` (grant `urn:ietf:params:oauth:grant-type:device_code`), loop honoring `authorization_pending`/`slow_down`/`expired_token`/`authorization_declined` at `interval`, bounded by `expiresIn`. Reuse the AADSTS `HINTS` map from `m365-credential.ts`.
- Constants: `DEVICE_CODE_CLIENT_ID`, `DEVICE_CODE_SCOPES`.
Unit-tested with a mocked fetch: initiate returns the code; poll transitions pending→pending→success; poll surfaces declined/expired distinctly; `slow_down` increases the interval.

### B. Runner — extract the shared MS-SSO login lib *(built; guarded by spanning regression tests)*
`runner/browser/lib/ms-sso-login.mjs` — move `SELECTORS`, `onActiveView`, `waitForCondition`, `mintOtp`, `scrubOtpField`, `handleSecondFactor`, and the login orchestration (spanning-force-sync L289–374) into an exported `signInMicrosoft({ page, shot, input, log, expectReturnTo? })`. **Refactor `spanning-force-sync.mjs` to import + call it** (behaviour-preserving — this is the risk; the spanning Pester/flow tests + a careful diff are the guard, since Playwright can't run here).

### C. Runner — the `entra-devicecode` browser flow *(built; live-validated)*
`runner/browser/flows/entra-devicecode.mjs`: `goto microsoft.com/devicelogin` → type `input.params.userCode` → **Continue** → `signInMicrosoft(...)` (shared) → click the consent/"you're signed in" confirmation → return `{ok, message:"device login complete"}`. Register in `run-flow.mjs` `FLOWS`.

### D. The GA-login secret shape *(testable here)*
Add `web/lib/secrets/field-requirements.ts` `"m365-global-admin"`: `M365 admin email` (anyOf Username/AdminEmail/UPN…) + `password` (anyOf Password/AdminPassword) — mirroring `spanning-portal`; comment that it's an interactive GA sign-in with **TOTP OTP enabled on the Delinea secret** (push/SMS unusable).

### E. Wiring *(built; live-validated)*
- `web/lib/jobs/adhoc.ts`: `ENTRA_DEVICECODE_KEY = "entra-devicecode"`.
- `web/lib/runner/capabilities.ts`: `BROWSER_SYSTEMS += "entra-devicecode"`.
- A dispatch route/service that creates the browser job carrying `config.userCode` + the GA `secretNames` (modeled on `force-spanning-sync/route.ts`). **The full per-client orchestration** (web initiates device-code → dispatches this browser job → polls the token → calls `provisionM365App`) is **Phase 4** — Phase 2 delivers the token function + the browser leg + the wiring primitives, not the end-to-end tie-together.
- `runner/Start-IamRunner.ps1`: `$DISPATCH['entra-devicecode']` block (passes `config.userCode` + the `OtpRequest` spec) + a small runner module caller `Invoke-CtgEntraDeviceCode` mirroring `Invoke-CtgSpanningForceSync`.

## Non-goals (Phase 2)
The end-to-end per-client orchestration + UI (Phase 4); the fleet run (Phase 5); Delinea write-back of the provisioned creds (Phase 3). Phase 2 stops at "a delegated GA Graph token can be obtained (web) and the browser can complete the device login (runner)."

## Testing / validation
- **Unit (here):** `device-code-auth.ts` (mocked fetch — initiate, poll transitions, error codes) + the `m365-global-admin` field-requirement + `capabilities`/`adhoc` registry tests.
- **Regression (here):** the extracted `ms-sso-login.mjs` must not change spanning's behaviour — run the existing spanning tests; review the refactor diff for exact behaviour preservation.
- **Live (operator):** the `entra-devicecode` browser flow + the device-code end-to-end need a real browser + a GA account (TOTP seed in Delinea) + a tenant — documented as the operator validation step. Push/SMS-MFA GA accounts are out (hard-stop).

## Deploy artifacts
Runner (new browser flow + shared SSO lib — a minor bump when Phase 2 ships end-to-end); a `m365-global-admin` Delinea secret per client (GA UPN + password + **OTP enabled on the secret**).
