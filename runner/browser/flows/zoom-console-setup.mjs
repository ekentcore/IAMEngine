// Flow: zoom-console-setup
// ---------------------------------------------------------------------------------------------
// Sign in to Zoom (as an admin, from a `zoom-console` email+password login, clearing a TOTP prompt by
// minting the code at the prompt) and create/harvest a **Server-to-Server OAuth** app in the Zoom App
// Marketplace — the `zoom` API credential (Account ID + Client ID + Client Secret). Modeled directly
// on runner/browser/flows/mimecast-console-signin.mjs (Phase 2): the runner harvests the shown creds
// and returns them note-only; the APP vaults them to Delinea. `params.signInOnly:true` proves the
// login works and changes nothing (the "Test sign-in" affordance).
//
// This is Zoom's OWN login, NOT M365 SSO — so it uses a bespoke sign-in (email -> Next -> password ->
// Next -> optional TOTP), reusing the shared hidden-view discipline (onActiveView / waitForCondition).
//
// LIVE-VALIDATION PENDING: never exercised against the live Zoom console (no Chromium here, and the
// Zoom sign-in + Marketplace DOM are unverified). Every selector is a resilient best-effort union in
// this directory's style, tagged with its console location, and each step logs which stage it reached
// so a live run pinpoints the first wrong selector. Harvested values are NEVER logged. Note: a Zoom
// account behind org SSO will not accept an email+password login — those tenants must paste the
// credential via the guided form instead.
import { onActiveView, waitForCondition } from "../lib/ms-sso-login.mjs";
import { totp } from "../lib/totp.mjs";

const DEFAULT_SIGNIN_URL = "https://zoom.us/signin";
const MARKETPLACE_CREATE_URL = "https://marketplace.zoom.us/develop/create";
const DEFAULT_APP_NAME = "iam-engine";

// Resilient selectors for Zoom's login (ids are not publicly stable — small unions, semantic first).
const Z = {
  email: 'input[type="email"], input[name="email"], input#email, input[autocomplete="username"], input[placeholder*="mail" i]',
  password: 'input[type="password"], input[name="password"], input#password, input[autocomplete="current-password"]',
  next: 'button[type="submit"], button:has-text("Next"), button:has-text("Continue"), button:has-text("Sign In"), button:has-text("Sign in"), input[type="submit"]',
  totp: 'input[autocomplete="one-time-code"], input[name*="otp" i], input[name*="code" i], input[id*="code" i], input[inputmode="numeric"]',
  totpNext: 'button[type="submit"], button:has-text("Verify"), button:has-text("Submit"), button:has-text("Continue")',
  error: '[role="alert"]:visible, .error:visible, [class*="error" i]:visible, [aria-live="assertive"]:visible',
};

// Server-to-Server OAuth app creation + credential harvest, on marketplace.zoom.us.
const A = {
  s2sTile: 'a:has-text("Server-to-Server OAuth"), button:has-text("Server-to-Server OAuth"), [href*="s2s" i], text="Server-to-Server OAuth"',
  createBtn: 'button:has-text("Create"), a:has-text("Create"), button[type="submit"]',
  appName: 'input[name*="name" i], input[id*="name" i], input[placeholder*="name" i]',
  // Existing app row by name (idempotency), from the "Manage" app list.
  appRow: (name) => `tr:has-text("${name}"), [role="row"]:has-text("${name}"), a:has-text("${name}")`,
  continue: 'button:has-text("Continue"), button:has-text("Next"), button[type="submit"]',
  activate: 'button:has-text("Activate"), button:has-text("Activate your app")',
  // App Credentials read-only fields. Zoom labels them "Account ID", "Client ID", "Client Secret".
  accountId: '[aria-label*="Account ID" i], input[readonly][id*="account" i], [data-testid*="account-id" i]',
  clientId: '[aria-label*="Client ID" i], input[readonly][id*="client-id" i], [data-testid*="client-id" i]',
  clientSecret: '[aria-label*="Client Secret" i], input[readonly][id*="client-secret" i], [data-testid*="client-secret" i]',
  copyable: 'input[readonly], code, [class*="copyable" i]',
};

// -------------------------------------------------------------------------------------------------
// PURE HELPERS (unit-tested; no browser)
// -------------------------------------------------------------------------------------------------

// Does `urlStr` look like a signed-in Zoom page (past the sign-in screen)? True on a zoom.us host whose
// path isn't a /signin|/login route. Tolerant: a non-URL yields false.
export function looksSignedIn(urlStr) {
  try {
    const u = new URL(urlStr);
    if (!u.hostname.toLowerCase().endsWith("zoom.us")) return false;
    if (/(^|\/)(signin|login|logon|sso)(\/|$)/i.test(u.pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

// The three harvested values are all present + non-empty. Used to decide success without logging them.
export function harvestComplete(h) {
  return Boolean(h && h.accountId && h.clientId && h.clientSecret);
}

// -------------------------------------------------------------------------------------------------
// SIGN-IN (bespoke — Zoom's own login, not MS SSO)
// -------------------------------------------------------------------------------------------------
async function mintOtp(otpReq, log) {
  // Zoom console MFA: mint the TOTP from the secret's seed if one is wired (params.totpSeed), else the
  // pre-minted code (params.otpCode). No live OTP-broker round-trip here (Zoom TOTP is app-based).
  try {
    if (otpReq?.otpCode) return String(otpReq.otpCode);
    if (otpReq?.totpSeed) return totp(otpReq.totpSeed);
  } catch (e) {
    log?.(`could not generate the Zoom TOTP code: ${e?.message ?? e}`);
  }
  return "";
}

async function signInZoom({ page, shot, input, log }) {
  const username = input?.username;
  const password = input?.password;
  if (!username || !password) {
    return { ok: false, error: "no Zoom console credentials brokered (email/password) — wire a 'zoom-console' secret with an admin email + password." };
  }
  try {
    const emailField = page.locator(Z.email).first();
    if (await waitForCondition(() => onActiveView(emailField), 15000)) {
      await emailField.fill(username);
      await page.locator(Z.next).first().click().catch(() => {});
      await page.waitForTimeout(1200);
    }
    if (looksSignedIn(page.url())) return { ok: true }; // existing session

    const pwField = page.locator(Z.password).first();
    if (!(await waitForCondition(() => onActiveView(pwField), 15000))) {
      return { ok: false, error: "could not reach the Zoom password field — VERIFY the sign-in selectors against the live console (or the account may be SSO-only).", evidence: await shot("zoom-no-password") };
    }
    await pwField.fill(password);
    await page.locator(Z.next).first().click().catch(() => {});
    await page.waitForTimeout(1800);

    const earlyErr = await page.locator(Z.error).first().innerText().catch(() => "");
    if (earlyErr && !looksSignedIn(page.url())) {
      return { ok: false, error: `Zoom rejected the sign-in: ${earlyErr.trim()}`, evidence: await shot("zoom-password-error") };
    }

    // Optional TOTP second factor.
    const otpField = page.locator(Z.totp).first();
    if (await onActiveView(otpField)) {
      const code = await mintOtp(input?.params?.otp, log);
      if (!code) {
        return { ok: false, error: "Zoom asked for a verification code but none was available — enable One-Time Password on the 'zoom-console' secret in Delinea, or complete the sign-in manually.", evidence: await shot("zoom-mfa-no-code") };
      }
      await otpField.fill(code);
      await page.locator(Z.totpNext).first().click().catch(() => {});
      await page.waitForTimeout(2000);
      const otpErr = await page.locator(Z.error).first().innerText().catch(() => "");
      if (otpErr && !looksSignedIn(page.url())) {
        return { ok: false, error: `the Zoom verification code was rejected: ${otpErr.trim()}`, evidence: await shot("zoom-mfa-rejected") };
      }
    }

    if (!looksSignedIn(page.url())) {
      return { ok: false, error: "the sign-in completed the password/code steps but did not reach a signed-in Zoom page — VERIFY the flow / an unexpected interstitial against the live console.", evidence: await shot("zoom-no-console") };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Zoom sign-in failed: ${e?.message ?? e}`, evidence: await shot("zoom-login-error") };
  }
}

// -------------------------------------------------------------------------------------------------
// CREATE THE SERVER-TO-SERVER OAUTH APP + HARVEST (LIVE-VALIDATION PENDING)
// -------------------------------------------------------------------------------------------------
async function harvestCredential(page) {
  const readVal = async (loc) => {
    const el = page.locator(loc).first();
    if (!(await el.count().catch(() => 0))) return "";
    return ((await el.inputValue().catch(() => "")) || (await el.getAttribute("value").catch(() => "")) || (await el.innerText().catch(() => "")) || "").trim();
  };
  let accountId = await readVal(A.accountId);
  let clientId = await readVal(A.clientId);
  let clientSecret = await readVal(A.clientSecret);
  if (!accountId || !clientId || !clientSecret) {
    // Fallback: the App Credentials panel renders the three values in order (Account ID, Client ID,
    // Client Secret) as read-only/copyable fields.
    const ro = page.locator(A.copyable);
    const n = await ro.count().catch(() => 0);
    const vals = [];
    for (let i = 0; i < n && vals.length < 3; i++) {
      const v = ((await ro.nth(i).inputValue().catch(() => "")) || (await ro.nth(i).innerText().catch(() => ""))).trim();
      if (v && v.length > 6) vals.push(v);
    }
    if (!accountId && vals[0]) accountId = vals[0];
    if (!clientId && vals[1]) clientId = vals[1];
    if (!clientSecret && vals[2]) clientSecret = vals[2];
  }
  return { accountId, clientId, clientSecret };
}

async function createS2sApp({ page, shot, input, log, appName }) {
  try {
    // 1. Go to the create page and pick Server-to-Server OAuth.
    log("opening the Zoom App Marketplace create page");
    await page.goto(MARKETPLACE_CREATE_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(1500);
    const tile = page.locator(A.s2sTile).first();
    if (await tile.isVisible().catch(() => false)) {
      await tile.click().catch(() => {});
      await page.waitForTimeout(800);
      // A "Create" on the S2S tile / dialog.
      await page.locator(A.createBtn).first().click().catch(() => {});
      await page.waitForTimeout(1000);
    }

    // 2. Name the app (a create dialog usually asks for a name).
    const nameField = page.locator(A.appName).first();
    if (await nameField.isVisible().catch(() => false)) {
      await nameField.fill(appName);
      await page.locator(A.createBtn).first().click().catch(() => {});
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(1800);
    }

    // 3. The App Credentials page shows Account ID / Client ID / Client Secret. Harvest them.
    log("reading App Credentials (Account ID / Client ID / Client Secret)");
    const harvested = await harvestCredential(page);
    if (!harvestComplete(harvested)) {
      return { ok: false, error: "the Server-to-Server OAuth app was created but its Account ID / Client ID / Client Secret could not be read — VERIFY the App Credentials selectors against the live Marketplace (the create wizard may require a name/company/scopes step first).", evidence: await shot("zoom-no-harvest") };
    }
    // 4. Best-effort: advance through the wizard and Activate (so the app is usable). Non-fatal.
    for (const step of [A.continue, A.continue, A.activate]) {
      const b = page.locator(step).first();
      if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); await page.waitForTimeout(1000); }
    }
    log("Server-to-Server OAuth app created and credential harvested"); // values NEVER logged
    return { ok: true, message: `created the Server-to-Server OAuth app "${appName}" and harvested its credential`, harvested };
  } catch (e) {
    return { ok: false, error: `Zoom S2S app creation failed: ${e?.message ?? e}`, evidence: await shot("zoom-createapp-error") };
  }
}

// -------------------------------------------------------------------------------------------------
// ENTRY
// -------------------------------------------------------------------------------------------------
export default async function zoomConsoleSetup({ page, shot, input, log }) {
  const signInOnly = input?.params?.signInOnly !== false; // default sign-in-only
  const appName = (input?.params?.appName && String(input.params.appName).trim()) || DEFAULT_APP_NAME;
  const signinUrl = (input?.params?.consoleUrl && String(input.params.consoleUrl).trim()) || DEFAULT_SIGNIN_URL;

  try {
    await page.goto(signinUrl, { waitUntil: "domcontentloaded" });
  } catch (e) {
    return { ok: false, error: `could not reach the Zoom sign-in (${signinUrl}): ${e?.message ?? e}`, evidence: await shot("nav") };
  }

  const signIn = await signInZoom({ page, shot, input, log });
  if (!signIn.ok) return signIn;

  if (signInOnly) return { ok: true, message: "signed in to Zoom" };
  return createS2sApp({ page, shot, input, log, appName });
}
