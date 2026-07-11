// Flow: spanning-force-sync
// ---------------------------------------------------------------------------------------------
// Log into the Spanning Backup admin portal and trigger an on-demand directory/user sync (the
// "scan for new users" action), so a just-created M365 user is discovered NOW instead of on
// Spanning's own schedule. The Spanning API has NO sync endpoint — that is the entire reason this
// last-resort browser flow exists (see runner/modules/Coretelligent.Spanning: onboarding otherwise
// returns RetryAfterMinutes and waits for Spanning to discover the user on its own).
//
// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
// VERIFY against the real portal. The exact login URL, the DOM selectors, and the location of the
// "sync / scan for new users" control are UNKNOWN without a live Spanning admin console. Everything
// in the SELECTORS block below is a best-guess placeholder. When a real portal is available:
//   1. confirm SPANNING_PORTAL_URL (the admin login, NOT the o365-api-* API host),
//   2. capture the real selectors (record with `npx playwright codegen <portal-url>`),
//   3. confirm whether the sync completes synchronously or is queued (drives SYNC_IS_ASYNC below),
//   4. confirm the second-factor type: app/TOTP is completed from a seed on the secret (input.params
//      .totpSeed); push / number-matching / SMS can't be automated and the flow hard-stops on them.
// Until then this flow degrades safely: if login or the sync control can't be found it returns a
// structured { ok:false, error, evidence:<screenshot> } instead of throwing or claiming success.
// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

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
const SELECTORS = {
  // The console's provider chooser: pick Microsoft 365 (vs KaseyaOne), which redirects to MS SSO.
  microsoftLogin: 'a:has-text("Log In with Microsoft"), a:has-text("Sign in with Microsoft"), button:has-text("Log In with Microsoft"), a:has-text("Microsoft 365")',
  // Microsoft 365 sign-in fields (loginfmt/passwd are the stable MS field names).
  username: 'input[type="email"], input[name="loginfmt"], input[name="username"], input#i0116, input#email',
  password: 'input[type="password"], input[name="passwd"], input[name="password"], input#i0118, input#password',
  submit: '#idSIButton9, input[type="submit"], button[type="submit"], button:has-text("Sign in"), button:has-text("Next"), button:has-text("Log in")',
  // The directory-sync / "scan for new users" trigger, and a confirmation the sync started.
  syncButton: 'button:has-text("Sync"), button:has-text("Scan for new users"), a:has-text("Sync now"), [data-action="sync-users"]',
  syncConfirmation: 'text=/sync (started|queued|initiated|in progress|complete)/i',
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
async function handleSecondFactor(page, shot, totpSeed, log) {
  try {
    // Unautomatable factors first — a push/number/SMS prompt can't be satisfied headless.
    if (await page.locator(SELECTORS.pushChallenge).first().isVisible().catch(() => false)) {
      return { bail: { ok: false, error: "the login requires push / number-matching / SMS MFA — a headless bot can't approve that. Switch the automation account to app (TOTP) MFA and put its seed on the secret, or trigger the Spanning sync manually.", evidence: await shot("mfa-push") } };
    }
    const otp = page.locator(SELECTORS.otpInput).first();
    const hasOtp = await otp.isVisible().catch(() => false);
    const textChallenge = await page.locator(SELECTORS.mfaChallenge).first().isVisible().catch(() => false);
    if (!hasOtp && !textChallenge) return { done: true }; // no second factor

    if (!totpSeed) {
      return { bail: { ok: false, error: "the login requires MFA and no TOTP seed is on the Spanning secret — add the authenticator seed (a TOTP/OTP field) so the sync can complete headless, or trigger it manually.", evidence: await shot("mfa-no-seed") } };
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
  const totpSeed = input?.params?.totpSeed ?? input?.totpSeed ?? null; // optional authenticator seed; NEVER logged

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
      const mfa = await handleSecondFactor(page, shot, totpSeed, log);
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

  // 3. Trigger the directory/user sync ("scan for new users").
  try {
    const syncBtn = page.locator(SELECTORS.syncButton).first();
    if (!(await syncBtn.isVisible().catch(() => false))) {
      return { ok: false, error: "logged in, but could not find the Spanning directory-sync control ('scan for new users') — VERIFY the portal navigation + selectors against the real console", evidence: await shot("no-sync-button") };
    }
    log("clicking the Spanning directory-sync control");
    await syncBtn.click();
    // Best-effort confirmation the sync kicked off.
    const confirmed = await page.locator(SELECTORS.syncConfirmation).first().isVisible({ timeout: 8000 }).catch(() => false);

    const message = confirmed
      ? `triggered a Spanning directory sync${email ? ` (to discover ${email})` : ""}`
      : `clicked the Spanning sync control${email ? ` (to discover ${email})` : ""} — no explicit confirmation text found (VERIFY the confirmation selector)`;

    // Async sync: tell the app to re-check the user shortly so the Spanning onboarding step can
    // confirm the license once the user is discovered.
    return { ok: true, message, evidence: null, ...(SYNC_IS_ASYNC ? { retryAfterMinutes: RETRY_AFTER_MINUTES } : {}) };
  } catch (e) {
    return { ok: false, error: `failed to trigger the Spanning sync: ${e?.message ?? e}`, evidence: await shot("sync-error") };
  }
}
