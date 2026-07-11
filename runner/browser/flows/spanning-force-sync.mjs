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
//   3. confirm whether the sync completes synchronously or is queued (drives SYNC_IS_ASYNC below).
// Until then this flow degrades safely: if login or the sync control can't be found it returns a
// structured { ok:false, error, evidence:<screenshot> } instead of throwing or claiming success.
// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

// The Spanning admin console login. The API base is o365-api-{region}.spanningbackup.com (NOT a
// browser login). The admin portal is reached from https://spanningbackup.com; for Spanning Backup
// for Microsoft 365 the admin console is typically the O365 app console. VERIFY the exact URL.
const SPANNING_PORTAL_URL = process.env.SPANNING_PORTAL_URL || "https://o365.spanningbackup.com/";

// If the portal reports the sync as "queued / started" rather than "finished", we ask the app to
// re-check the user shortly (the Spanning onboarding step re-runs and confirms the license). VERIFY
// whether the portal exposes a completion signal; until then assume async + a short recheck window.
const SYNC_IS_ASYNC = true;
const RETRY_AFTER_MINUTES = 10;

// VERIFY every selector below against the real portal DOM.
const SELECTORS = {
  // Basic login form (username/password). Microsoft-federated tenants land on login.microsoftonline.com
  // instead — see the MFA/federation detection in run().
  username: 'input[type="email"], input[name="username"], input#username, input#email',
  password: 'input[type="password"], input[name="password"], input#password',
  submit: 'button[type="submit"], input[type="submit"], button:has-text("Sign in"), button:has-text("Log in")',
  // The directory-sync / "scan for new users" trigger, and a confirmation the sync started.
  syncButton: 'button:has-text("Sync"), button:has-text("Scan for new users"), a:has-text("Sync now"), [data-action="sync-users"]',
  syncConfirmation: 'text=/sync (started|queued|initiated|in progress|complete)/i',
  // Anything that indicates a second-factor / federated challenge we can't complete headless.
  mfaChallenge: 'text=/verify your identity|enter code|authenticator|two-factor|2FA|one-time (code|passcode)/i',
};

// Detect a second-factor / federated MFA challenge on the current page. Basic (username+password)
// login only is supported; anything interactive is a hard stop with a clear message.
async function looksLikeMfa(page) {
  try {
    const url = page.url();
    if (/login\.microsoftonline\.com|\/oauth2\/|\/saml/i.test(url)) {
      // Federated sign-in almost always adds an interactive step (consent / MFA) we can't drive.
      const hasPw = await page.locator(SELECTORS.password).first().isVisible().catch(() => false);
      if (!hasPw) return true;
    }
    return await page.locator(SELECTORS.mfaChallenge).first().isVisible().catch(() => false);
  } catch {
    return false;
  }
}

export default async function spanningForceSync({ page, shot, input, log }) {
  const email = input?.params?.email ?? null;
  const username = input?.username ?? null;
  const password = input?.password ?? null; // NEVER logged

  if (!username || !password) {
    return { ok: false, error: "no Spanning portal credentials brokered (username/password) — set them on the client's Spanning secret" };
  }

  // 1. Navigate to the portal.
  try {
    log(`navigating to the Spanning admin portal (${SPANNING_PORTAL_URL})`);
    await page.goto(SPANNING_PORTAL_URL, { waitUntil: "domcontentloaded" });
  } catch (e) {
    return { ok: false, error: `could not reach the Spanning portal (${SPANNING_PORTAL_URL}) — VERIFY the URL: ${e?.message ?? e}`, evidence: await shot("nav") };
  }

  // 2. Basic login (username + password). Bail clearly on an MFA/federation challenge.
  try {
    const userField = page.locator(SELECTORS.username).first();
    if (await userField.isVisible().catch(() => false)) {
      log("entering the portal username");
      await userField.fill(username);
      // Some portals split username/password across two steps — submit if there is no password yet.
      const pwVisible = await page.locator(SELECTORS.password).first().isVisible().catch(() => false);
      if (!pwVisible) {
        await page.locator(SELECTORS.submit).first().click().catch(() => {});
        await page.waitForTimeout(1500);
      }
    }

    if (await looksLikeMfa(page)) {
      return { ok: false, error: "portal requires MFA — browser automation can't complete (basic username/password login only). Trigger the Spanning sync manually in the admin console.", evidence: await shot("mfa") };
    }

    const pwField = page.locator(SELECTORS.password).first();
    if (!(await pwField.isVisible().catch(() => false))) {
      return { ok: false, error: "could not find the password field on the Spanning login page — VERIFY the portal URL and selectors against the real console", evidence: await shot("no-password-field") };
    }
    log("entering the portal password"); // the VALUE is never logged
    await pwField.fill(password);
    await page.locator(SELECTORS.submit).first().click();
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(2000);

    // A post-submit MFA prompt (2FA after password) — same hard stop.
    if (await looksLikeMfa(page)) {
      return { ok: false, error: "portal requires MFA — browser automation can't complete (basic username/password login only). Trigger the Spanning sync manually in the admin console.", evidence: await shot("mfa-post") };
    }

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
