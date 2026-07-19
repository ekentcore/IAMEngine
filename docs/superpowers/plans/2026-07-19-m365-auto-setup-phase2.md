# M365 auto-setup — Phase 2 (browser GA-auth → device-code token) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Obtain a delegated Microsoft Graph token with a client's Global-Admin privileges via an OAuth device-code flow (web init+poll) + a headless browser leg that completes `microsoft.com/devicelogin`, ready to feed Phase 1's `provisionM365App`.

**Architecture:** Web TS `device-code-auth.ts` (initiate + poll, modeled on `acquireGraphToken`); a new runner browser flow `entra-devicecode.mjs` on a new shared `ms-sso-login.mjs`; a `m365-global-admin` GA secret shape; registry/dispatch wiring. The token stays web-side (never crosses the sidecar boundary).

**Tech Stack:** Next.js/TS (`web/`), `node:test` via `tsx --test`; Node/Playwright sidecar (`runner/browser`).

## Global Constraints
- Commit + changelog per feature (Phase 2 = one changelog entry at the end; changelog `time` = `TZ=America/New_York date +%H:%M` floored ≤ now; one file in `web/lib/changelog/entries/` + registered id-sorted).
- Commit trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- tsc gate: only the 3 known pre-existing `warningsDismissed` errors.
- **Do NOT modify `runner/browser/flows/spanning-force-sync.mjs`** — it is live-validated production MS-SSO code that cannot be Playwright-tested here. The shared `ms-sso-login.mjs` is written FRESH (mirroring spanning's proven logic); converging spanning onto it is a documented live-validated follow-up, NOT this phase.
- **Live-validation boundary:** the browser flow (`entra-devicecode.mjs`) and the end-to-end device-code run need a real browser + GA account (TOTP seed in Delinea) + tenant — the operator validates. Only the web functions + registry + secret shape are unit-tested here.
- First-party client id `14d82eec-204b-4c2f-b7e8-296a70dab67e`; scopes `Application.ReadWrite.All AppRoleAssignment.ReadWrite.All RoleManagement.ReadWrite.Directory Directory.ReadWrite.All offline_access`.

---

## Task 1: `device-code-auth.ts` — initiate + poll *(testable)*
**Files:** Create `web/lib/secrets/device-code-auth.ts` + `.test.ts`.
**Interfaces:** `startDeviceCode(tenant, fetcher?) → { ok:true; deviceCode; userCode; verificationUri; interval; expiresIn } | { ok:false; error }`; `pollDeviceCodeToken(tenant, deviceCode, opts, fetcher?) → { ok:true; token } | { ok:false; error; code? }` where `opts = { intervalSeconds; expiresInSeconds; sleep?: (ms)=>Promise<void> }` (inject `sleep` so tests don't wait); `DEVICE_CODE_CLIENT_ID`, `DEVICE_CODE_SCOPES`.

- [ ] **Step 1: Failing tests** (`device-code-auth.test.ts`, `node:test`, mocked fetch, injected `sleep: async()=>{}`):
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { startDeviceCode, pollDeviceCodeToken } from "./device-code-auth";

const OK = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const ERR = (b: unknown, status = 400) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

test("startDeviceCode returns the user code + verification uri", async () => {
  const f = (async () => OK({ device_code: "dc", user_code: "ABCD-EFGH", verification_uri: "https://microsoft.com/devicelogin", interval: 5, expires_in: 900 })) as unknown as typeof fetch;
  const r = await startDeviceCode("tenant.com", f);
  assert.equal(r.ok && r.userCode, "ABCD-EFGH");
  assert.equal(r.ok && r.deviceCode, "dc");
});

test("pollDeviceCodeToken loops through authorization_pending then succeeds", async () => {
  let n = 0;
  const f = (async () => (++n < 3 ? ERR({ error: "authorization_pending" }) : OK({ access_token: "the-token" }))) as unknown as typeof fetch;
  const r = await pollDeviceCodeToken("tenant.com", "dc", { intervalSeconds: 5, expiresInSeconds: 900, sleep: async () => {} }, f);
  assert.equal(r.ok && r.token, "the-token");
  assert.equal(n, 3);
});

test("pollDeviceCodeToken surfaces authorization_declined distinctly (no retry)", async () => {
  let n = 0;
  const f = (async () => { n++; return ERR({ error: "authorization_declined" }); }) as unknown as typeof fetch;
  const r = await pollDeviceCodeToken("tenant.com", "dc", { intervalSeconds: 5, expiresInSeconds: 900, sleep: async () => {} }, f);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, "authorization_declined");
  assert.equal(n, 1); // terminal, not retried
});

test("pollDeviceCodeToken gives up on expired_token / deadline", async () => {
  const f = (async () => ERR({ error: "expired_token" })) as unknown as typeof fetch;
  const r = await pollDeviceCodeToken("tenant.com", "dc", { intervalSeconds: 5, expiresInSeconds: 900, sleep: async () => {} }, f);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, "expired_token");
});
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** (model the token host/body on `acquireGraphToken` in `m365-credential.ts`):
```ts
export const DEVICE_CODE_CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e"; // Microsoft Graph PowerShell (public client, device-code capable)
export const DEVICE_CODE_SCOPES = "Application.ReadWrite.All AppRoleAssignment.ReadWrite.All RoleManagement.ReadWrite.Directory Directory.ReadWrite.All offline_access";
const AUTH_HOST = "https://login.microsoftonline.com";
const PENDING = new Set(["authorization_pending", "slow_down"]);

export async function startDeviceCode(tenant: string, fetcher: typeof fetch = fetch): Promise<
  { ok: true; deviceCode: string; userCode: string; verificationUri: string; interval: number; expiresIn: number } | { ok: false; error: string }> {
  try {
    const body = new URLSearchParams({ client_id: DEVICE_CODE_CLIENT_ID, scope: DEVICE_CODE_SCOPES });
    const res = await fetcher(`${AUTH_HOST}/${encodeURIComponent(tenant)}/oauth2/v2.0/devicecode`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString(), signal: AbortSignal.timeout(20_000),
    });
    const d = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok || !d?.device_code) return { ok: false, error: String(d?.error_description ?? d?.error ?? `HTTP ${res.status}`) };
    return { ok: true, deviceCode: String(d.device_code), userCode: String(d.user_code), verificationUri: String(d.verification_uri), interval: Number(d.interval ?? 5), expiresIn: Number(d.expires_in ?? 900) };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

export async function pollDeviceCodeToken(
  tenant: string, deviceCode: string,
  opts: { intervalSeconds: number; expiresInSeconds: number; sleep?: (ms: number) => Promise<void> },
  fetcher: typeof fetch = fetch
): Promise<{ ok: true; token: string } | { ok: false; error: string; code?: string }> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let interval = Math.max(1, opts.intervalSeconds);
  const deadline = Date.now() + opts.expiresInSeconds * 1000;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    try {
      const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: DEVICE_CODE_CLIENT_ID, device_code: deviceCode });
      const res = await fetcher(`${AUTH_HOST}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString(), signal: AbortSignal.timeout(20_000),
      });
      const d = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (res.ok && d?.access_token) return { ok: true, token: String(d.access_token) };
      const code = String(d?.error ?? `HTTP ${res.status}`);
      if (code === "slow_down") { interval += 5; continue; }
      if (code === "authorization_pending") continue;
      return { ok: false, error: String(d?.error_description ?? code), code }; // declined / expired / bad_verification_code
    } catch { /* transient — keep polling until deadline */ }
  }
  return { ok: false, error: "device code expired before sign-in completed", code: "expired_token" };
}
```

- [ ] **Step 4: Run — PASS.** tsc clean. **Commit** `feat(secrets): device-code auth — initiate + poll for a delegated GA Graph token` + trailer.

---

## Task 2: `m365-global-admin` GA-login secret shape *(testable)*
**Files:** Modify `web/lib/secrets/field-requirements.ts` (+ its test if one exists).
- [ ] **Step 1:** Add after the `spanning-portal` entry:
```ts
  "m365-global-admin": [
    { label: "M365 Global Admin email (UPN)", anyOf: ["Username", "AdminEmail", "AdminUser", "Email", "UPN", "User"] },
    { label: "that account's password", anyOf: ["Password", "AdminPassword"] },
  ],
```
with a comment: interactive GA sign-in the device-code browser flow logs in WITH; MFA must be **TOTP with the seed / One-Time Password enabled on the Delinea secret** (push/SMS can't be automated). Mirror the `spanning-portal` comment.
- [ ] **Step 2:** If `field-requirements.test.ts` exists, add an assertion the new key resolves its fields; run it. tsc clean. **Commit** `feat(secrets): m365-global-admin GA interactive-login secret shape` + trailer.

---

## Task 3: registry wiring *(testable)*
**Files:** Modify `web/lib/jobs/adhoc.ts`, `web/lib/runner/capabilities.ts`.
- [ ] **Step 1:** `adhoc.ts`: `export const ENTRA_DEVICECODE_KEY = "entra-devicecode";` and include it in `ADHOC_SYSTEM_KEYS` if that's how spanning-force-sync is registered (mirror `SPANNING_FORCE_SYNC_KEY`).
- [ ] **Step 2:** `capabilities.ts`: add `"entra-devicecode"` to `BROWSER_SYSTEMS`.
- [ ] **Step 3:** Run the capabilities/adhoc tests (if any) + tsc clean. **Commit** `feat(runner): register entra-devicecode as a browser system` + trailer.

---

## Task 4: browser flow — shared `ms-sso-login.mjs` + `entra-devicecode.mjs` *(built; LIVE-VALIDATED, no unit test)*
**Files:** Create `runner/browser/lib/ms-sso-login.mjs`, `runner/browser/flows/entra-devicecode.mjs`; modify `runner/browser/run-flow.mjs` (register the flow), `runner/Start-IamRunner.ps1` (`$DISPATCH['entra-devicecode']`), and a runner module caller. **Do NOT touch spanning-force-sync.mjs.**
- [ ] **Step 1:** Create `ms-sso-login.mjs` exporting `signInMicrosoft({ page, shot, input, log, expectReturnTo })` — port (write fresh, do not edit spanning) the proven logic: `SELECTORS`, `onActiveView` (the aria-hidden + width>40 check), `waitForCondition`, `mintOtp` (POST to the credential endpoint), `scrubOtpField`, `handleSecondFactor` (push/SMS hard-stop; TOTP via Delinea; 30s-window retry), and the orchestration username→(onActiveView)→password→submit→handleSecondFactor→MS-error-gate→KMSI. Reference the current spanning-force-sync.mjs L87-374 as the source of truth to reproduce faithfully (copy the exact selectors + logic).
- [ ] **Step 2:** Create `entra-devicecode.mjs`: `goto https://microsoft.com/devicelogin` → type `input.params.userCode` into the code box → Continue → `signInMicrosoft(...)` → click the "Continue"/consent/"you're signed in" confirmation → `return { ok: true, message: "device login complete" }`. Fail-soft with `shot()` evidence on error (mirror spanning's error result shape).
- [ ] **Step 3:** Register in `run-flow.mjs` `FLOWS`: `"entra-devicecode": () => import("./flows/entra-devicecode.mjs"),`.
- [ ] **Step 4:** Add `$DISPATCH['entra-devicecode']` in `Start-IamRunner.ps1` (mirror `spanning-force-sync`): pick the `m365-global-admin` secret, build the `OtpRequest` spec `@{ url="$AppUrl/api/jobs/$($job.id)/credential"; token=$ApiToken; agentId=$AgentId; secretName }`, pass `params.userCode = (Get-CtgProp $job.config 'userCode')` + the OtpRequest, call a new `Invoke-CtgEntraDeviceCode` module function (mirror `Invoke-CtgSpanningForceSync`: build `$flowInput = @{ username; password; params }`, call `Invoke-CtgBrowserFlow -Flow 'entra-devicecode' ...`, map the result).
- [ ] **Step 5:** **Verify (no Playwright here):** parse-check `Start-IamRunner.ps1` + `node --check runner/browser/lib/ms-sso-login.mjs runner/browser/flows/entra-devicecode.mjs`; confirm `run-flow.mjs` FLOWS registration; confirm spanning-force-sync.mjs is UNCHANGED (`git diff --stat` shows it untouched). **Commit** `feat(runner): entra-devicecode browser flow + shared ms-sso-login lib (live-validation pending)` + trailer.

---

## Task 5: Changelog + full verification
- [ ] **Step 1:** `web/lib/changelog/entries/m365-devicecode-auth.ts` (`id: "m365-devicecode-auth"`, date `2026-07-19`, floored non-future time). Title "Groundwork: device-code GA auth for automated M365 setup". Items: internal device-code token acquisition + a browser flow that completes microsoft.com/devicelogin as the Global Admin (TOTP MFA via Delinea) — feeds the app-provisioning core; not yet wired end-to-end (later phase); browser leg needs live validation. Register id-sorted.
- [ ] **Step 2:** `cd web && npx tsx --test "lib/**/*.test.ts"` green; `npx tsc --noEmit` only the 3 known errors; `node --check` the two .mjs; parse-check the PS.
- [ ] **Step 3:** Commit `docs(changelog): m365 device-code auth` + trailer.

## Verification (Phase 2 done when)
Web device-code fns unit-tested (initiate, poll transitions, declined/expired distinct); GA secret shape + registry wired + tested; the browser flow + shared SSO lib written, `node --check`-clean, spanning untouched; full web suite green; tsc clean. **Live (operator):** run the device-code flow against a real tenant + GA (TOTP) to validate the browser leg.
