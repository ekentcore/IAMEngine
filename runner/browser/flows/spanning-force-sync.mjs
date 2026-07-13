// Flow: spanning-force-sync
// ---------------------------------------------------------------------------------------------
// Log into the Spanning Backup admin portal and trigger an on-demand directory/user sync (the
// "scan for new users" action), so a just-created M365 user is discovered NOW instead of on
// Spanning's own schedule. The Spanning API has NO sync endpoint — that is the entire reason this
// last-resort browser flow exists (see runner/modules/Coretelligent.Spanning: onboarding otherwise
// returns RetryAfterMinutes and waits for Spanning to discover the user on its own).
//
// VERIFIED against the live console (2026-07-12), including a HAR capture of a real sync:
//   * login: SPANNING_PORTAL_URL -> "Log In with Microsoft" -> M365 SSO. Confirmed working.
//   * MFA: the code is minted by DELINEA (one-time password enabled on the secret) and fetched when
//     the prompt appears — no TOTP seed is stored or handled by us. Push / number-matching / SMS
//     still cannot be automated; the flow hard-stops on those with a screenshot.
//   * SYNC: clicking "Sync" in the console fires exactly ONE state-changing request —
//       POST https://o365-us.spanningbackup.com/api/sync   body {}
//         -> 200 {"id":<jobId>,"tenant_id":…,"status":"PENDING"}
//       GET  /api/tenantCache/<jobId>    (the console then just polls this)
//     So we REPLAY that call from inside the logged-in page instead of hunting for a button. There
//     are deliberately no sync selectors any more: a button can be redesigned away, the endpoint is
//     what the button actually does. The page's own session is used (same-origin fetch with
//     credentials), so no token is ever extracted.
// The sync is ASYNC: a still-PENDING job is reported as "started" (not a failure) with
// retryAfterMinutes, and the Spanning onboarding step re-checks the user on its own retry.

// The Spanning Backup for Microsoft 365 admin console (verified from spanning.com/login → the "Log In
// with Microsoft 365" destination). It lands on a provider chooser (Microsoft / KaseyaOne); clicking
// "Log In with Microsoft" hands off to Microsoft 365 SSO. The API base (o365-api-{region}…) is a
// SEPARATE credential and not used here. (Google console is spanningbackup.com/app/, Salesforce
// sf.spanningbackup.com — not handled by this M365 flow.)
const SPANNING_PORTAL_URL = process.env.SPANNING_PORTAL_URL || "https://o365.spanningbackup.com/login.html";

// If the portal reports the sync as "queued / started" rather than "finished", we ask the app to
// re-check the user shortly (the Spanning onboarding step re-runs and confirms the license). VERIFY
// whether the portal exposes a completion signal; until then assume async + a short recheck window.
const SYNC_IS_ASYNC = true;
const RETRY_AFTER_MINUTES = 10;

import { totp } from "../lib/totp.mjs";

// VERIFY the post-login (sync-control) selectors against the real console DOM; the login path below
// is confirmed against o365.spanningbackup.com/login.html → Microsoft 365 SSO.
// How long we'll watch the sync job before handing back to the app's own retry (it's async).
const POLL_MS = 45_000;

const SELECTORS = {
  // The console's provider chooser: pick Microsoft 365 (vs KaseyaOne), which redirects to MS SSO.
  microsoftLogin: 'a:has-text("Log In with Microsoft"), a:has-text("Sign in with Microsoft"), button:has-text("Log In with Microsoft"), a:has-text("Microsoft 365")',
  // Microsoft 365 sign-in fields (loginfmt/passwd are the stable MS field names).
  username: 'input[type="email"], input[name="loginfmt"], input[name="username"], input#i0116, input#email',
  password: 'input[type="password"], input[name="passwd"], input[name="password"], input#i0118, input#password',
  submit: '#idSIButton9, input[type="submit"], button[type="submit"], button:has-text("Sign in"), button:has-text("Next"), button:has-text("Log in")',
  // A TOTP/authenticator CODE-entry field. If present and a seed is on the secret, we generate and
  // enter the code (M365's is input[name="otc"]).
  otpInput: 'input[autocomplete="one-time-code"], input[name="otc"], input[name="otp"], input[name="code"], input[id*="otc" i], input[id*="otp" i]',
  otpSubmit: 'button[type="submit"], input[type="submit"], button:has-text("Verify"), button:has-text("Sign in")',
  // A second factor we CAN'T automate headless (push approval / number-matching / SMS / phone call).
  pushChallenge: 'text=/approve.*(sign|request)|open your authenticator|enter the number|number shown|tap (yes|approve)|check your (phone|device)|we(\'| a)re calling|text.*code to|send.*(code|sms)/i',
  // Any generic "second factor / enter code" wording (used to notice a code prompt we don't otherwise match).
  mfaChallenge: 'text=/verify your identity|enter (the )?code|authenticator|two-factor|2FA|one-time (code|passcode)/i',
};

// Handle a possible second factor after the password step. Returns { done:true } when past MFA (or
// there is none), or { bail:<structured error> } when we can't proceed. A TOTP/app code is completed
// from the seed on the secret; push/number-matching/SMS is a hard stop (no live device).
async function handleSecondFactor(page, shot, otpCode, totpSeed, log) {
  try {
    // Unautomatable factors first — a push/number/SMS prompt can't be satisfied headless.
    if (await page.locator(SELECTORS.pushChallenge).first().isVisible().catch(() => false)) {
      return { bail: { ok: false, error: "the login requires push / number-matching / SMS MFA — a headless bot can't approve that. Switch the automation account to app (authenticator) MFA and enable One-Time Password on its Delinea secret, or trigger the Spanning sync manually.", evidence: await shot("mfa-push") } };
    }
    const otp = page.locator(SELECTORS.otpInput).first();
    const hasOtp = await otp.isVisible().catch(() => false);
    const textChallenge = await page.locator(SELECTORS.mfaChallenge).first().isVisible().catch(() => false);
    if (!hasOtp && !textChallenge) return { done: true }; // no second factor

    // PREFERRED: a code already minted by Delinea (fetched moments ago, so still valid). We never
    // hold the seed. LEGACY: generate from a stored seed if that's all the secret has.
    if (otpCode && hasOtp) {
      log("MFA code prompt — using the one-time password Delinea minted");
      await otp.fill(String(otpCode));
      await page.locator(SELECTORS.otpSubmit).first().click().catch(() => {});
      await page.waitForTimeout(3500);
      if (await page.locator(SELECTORS.otpInput).first().isVisible().catch(() => false)) {
        return { bail: { ok: false, error: "the one-time password was rejected — it may have expired in transit, or the account's MFA is not the authenticator this Delinea secret holds", evidence: await shot("otp-rejected") } };
      }
      return {};
    }
    if (!totpSeed) {
      return { bail: { ok: false, error: "the login requires MFA but no code was available — enable One-Time Password on the Spanning secret in Delinea (paste the authenticator seed there once); the runner then fetches a fresh code each run. Or trigger the sync manually.", evidence: await shot("mfa-no-code") } };
    }
    if (!hasOtp) {
      return { bail: { ok: false, error: "an MFA challenge appeared but no code-entry field was found — if it's a push/number prompt it can't be automated; if it's a code prompt, VERIFY the otpInput selector against the real console.", evidence: await shot("mfa-no-code-field") } };
    }
    log("entering the authenticator code"); // the code is never logged
    let code;
    try { code = totp(totpSeed); } catch (e) { return { bail: { ok: false, error: `could not generate the TOTP code from the secret's seed: ${e?.message ?? e}`, evidence: await shot("totp-error") } }; }
    await otp.fill(code);
    await page.locator(SELECTORS.otpSubmit).first().click().catch(() => {});
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(1500);
    // Still on a code field ⇒ the code was rejected (bad seed, or not app/TOTP MFA).
    if (await page.locator(SELECTORS.otpInput).first().isVisible().catch(() => false)) {
      return { bail: { ok: false, error: "the TOTP code was not accepted — check the seed on the Spanning secret and that the automation account uses app/TOTP MFA (not push/SMS).", evidence: await shot("otp-rejected") } };
    }
    return { done: true };
  } catch (e) {
    return { bail: { ok: false, error: `second-factor handling failed: ${e?.message ?? e}`, evidence: await shot("mfa-error") } };
  }
}

export default async function spanningForceSync({ page, shot, input, log }) {
  const email = input?.params?.email ?? null;
  const username = input?.username ?? null;
  const password = input?.password ?? null; // NEVER logged
  const otpCode = input?.params?.otpCode ?? null;   // a CURRENT code minted by Delinea — preferred; NEVER logged
  const totpSeed = input?.params?.totpSeed ?? input?.totpSeed ?? null; // legacy stored seed; NEVER logged

  if (!username || !password) {
    return { ok: false, error: "no Spanning portal credentials brokered (username/password) — set them on the client's Spanning secret" };
  }

  // 1. Navigate to the console, then pick "Log In with Microsoft" to hand off to Microsoft 365 SSO.
  try {
    log(`navigating to the Spanning admin console (${SPANNING_PORTAL_URL})`);
    await page.goto(SPANNING_PORTAL_URL, { waitUntil: "domcontentloaded" });
    const msBtn = page.locator(SELECTORS.microsoftLogin).first();
    if (await msBtn.isVisible().catch(() => false)) {
      log('selecting "Log In with Microsoft"');
      await msBtn.click().catch(() => {});
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(2000);
    }
  } catch (e) {
    return { ok: false, error: `could not reach the Spanning console (${SPANNING_PORTAL_URL}) — VERIFY the URL: ${e?.message ?? e}`, evidence: await shot("nav") };
  }

  // 2. Login (username + password), then clear a second factor if present. A TOTP/app code is
  //    completed from the seed on the secret; push/number-matching/SMS is a clear hard stop.
  try {
    const userField = page.locator(SELECTORS.username).first();
    if (await userField.isVisible().catch(() => false)) {
      log("entering the portal username");
      await userField.fill(username);
      // Some portals split username/password across two steps (and Microsoft-federated tenants redirect
      // to login.microsoftonline.com) — submit to advance if there is no password field yet.
      const pwVisible = await page.locator(SELECTORS.password).first().isVisible().catch(() => false);
      if (!pwVisible) {
        await page.locator(SELECTORS.submit).first().click().catch(() => {});
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        await page.waitForTimeout(1500);
      }
    }

    const pwField = page.locator(SELECTORS.password).first();
    if (!(await pwField.isVisible().catch(() => false))) {
      // No password field — could be an MFA-first / passwordless prompt. Let the second-factor handler
      // report precisely (push vs code vs unknown) instead of a generic "no password field".
      const mfa = await handleSecondFactor(page, shot, otpCode, totpSeed, log);
      if (mfa.bail) return mfa.bail;
      return { ok: false, error: "could not find the password field on the Spanning login page — VERIFY the portal URL and selectors against the real console", evidence: await shot("no-password-field") };
    }
    log("entering the portal password"); // the VALUE is never logged
    await pwField.fill(password);
    await page.locator(SELECTORS.submit).first().click();
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(2000);

    // Second factor after the password (the common case) — complete via TOTP or bail clearly.
    const mfa = await handleSecondFactor(page, shot, totpSeed, log);
    if (mfa.bail) return mfa.bail;

    // Still on a password field after submit ⇒ the login was rejected (or the selectors are wrong).
    if (await pwField.isVisible().catch(() => false)) {
      return { ok: false, error: "Spanning portal login did not succeed (still on the login page) — check the brokered portal credentials, or VERIFY the login selectors", evidence: await shot("login-failed") };
    }
  } catch (e) {
    return { ok: false, error: `Spanning portal login failed: ${e?.message ?? e}`, evidence: await shot("login-error") };
  }

  // 3. Trigger the sync — by REPLAYING the console's own API call, not by hunting for a button.
  //
  // Captured from a real session (HAR): clicking "Sync now" in the console fires exactly one
  // state-changing request, and then the UI just polls it:
  //
  //   POST https://o365-us.spanningbackup.com/api/sync      body: {}
  //     -> 200 {"id":17849871,"tenant_id":15529,"ts":"…","status":"PENDING"}
  //   GET  /api/tenantCache/{id}                            (poll until status leaves PENDING)
  //
  // We issue it from INSIDE the logged-in page (page.evaluate -> same-origin fetch), so the session
  // cookie / JWT the console already holds is sent automatically — we never extract or handle a
  // token. This is why there are no sync SELECTORS any more: a DOM button can be redesigned away,
  // this endpoint is what the button actually does.
  try {
    // The API is on the REGIONAL host (o365-us…), which is where the console lands after login.
    // Be explicit rather than assuming: same-origin fetch requires us to be ON that origin.
    const origin = new URL(page.url()).origin;
    if (!/spanningbackup\.com$/.test(new URL(origin).hostname)) {
      return { ok: false, error: `after login the page is on ${origin}, not a Spanning console origin — cannot fire the sync from here`, evidence: await shot("wrong-origin") };
    }

    log(`triggering the Spanning sync (POST ${origin}/api/sync)`);
    const fired = await page.evaluate(async () => {
      const r = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        credentials: "include",
      });
      let body = null;
      try { body = await r.json(); } catch { body = null; }
      return { status: r.status, body };
    });

    if (fired.status === 401 || fired.status === 403) {
      return { ok: false, error: `the Spanning console rejected the sync call (HTTP ${fired.status}) — the signed-in account may not be a Spanning admin`, evidence: await shot("sync-denied") };
    }
    if (fired.status < 200 || fired.status >= 300) {
      return { ok: false, error: `POST /api/sync returned HTTP ${fired.status}`, evidence: await shot("sync-failed") };
    }

    const jobId = fired.body && fired.body.id;
    const started = fired.body && fired.body.status;
    log(`sync accepted (id=${jobId ?? "?"} status=${started ?? "?"})`);

    // Poll the same endpoint the console polls. The sync is ASYNC — PENDING can persist well past a
    // sensible wait — so a still-pending job is NOT a failure: we've done our job by kicking it off,
    // and the Spanning onboarding step re-checks the user on its own retry.
    let finalStatus = started ?? "PENDING";
    if (jobId) {
      const deadline = Date.now() + POLL_MS;
      while (Date.now() < deadline) {
        await page.waitForTimeout(3000);
        const p = await page.evaluate(async (id) => {
          const r = await fetch(`/api/tenantCache/${id}`, { credentials: "include" });
          try { return await r.json(); } catch { return null; }
        }, jobId);
        if (p && p.status) {
          finalStatus = p.status;
          if (String(p.status).toUpperCase() !== "PENDING") break;
        }
      }
    }

    const done = String(finalStatus).toUpperCase() !== "PENDING";
    const message = done
      ? `Spanning sync completed (status ${finalStatus})${email ? ` — ${email} should now be discoverable` : ""}`
      : `Spanning sync started (id ${jobId ?? "?"}, still ${finalStatus})${email ? ` — ${email} will appear once it finishes` : ""}`;

    // Still pending -> ask the app to re-check shortly, so the onboarding step can confirm the
    // license once Spanning has actually discovered the user.
    return {
      ok: true,
      message,
      evidence: await shot("sync-triggered"),
      ...(done ? {} : { retryAfterMinutes: RETRY_AFTER_MINUTES }),
    };
  } catch (e) {
    return { ok: false, error: `failed to trigger the Spanning sync: ${e?.message ?? e}`, evidence: await shot("sync-error") };
  }
}
