// Flow: knowbe4-console-setup
// ---------------------------------------------------------------------------------------------
// Sign in to the KnowBe4 console (as an admin, from a `knowbe4-console` email+password login, clearing
// a TOTP prompt by minting the code at the prompt) and enable + harvest the **SCIM provisioning token**
// — the `knowbe4` API credential. KnowBe4 has no create-user REST API; all lifecycle writes go through
// SCIM 2.0 with a bearer token (Account Settings → User Management → SCIM). Modeled directly on
// runner/browser/flows/zoom-console-setup.mjs / mimecast-console-signin.mjs (Phase 2): the runner
// harvests the shown token and returns it note-only; the APP vaults it to Delinea. `params.signInOnly:
// true` proves the login works and changes nothing (the "Test sign-in" affordance).
//
// This is KnowBe4's OWN login, NOT M365 SSO — so it uses a bespoke sign-in (email -> password -> optional
// TOTP), reusing the shared hidden-view discipline (onActiveView / waitForCondition).
//
// LIVE-VALIDATION PENDING: never exercised against the live KnowBe4 console (no Chromium here, and the
// KnowBe4 sign-in + SCIM settings DOM are unverified). Every selector is a resilient best-effort union
// in this directory's style, tagged with its console location, and each step logs which stage it reached
// so a live run pinpoints the first wrong selector. The harvested token is NEVER logged. Note: a KnowBe4
// account behind org SSO will not accept an email+password login — those tenants must paste the token
// via the guided form instead.
import { onActiveView, waitForCondition } from "../lib/ms-sso-login.mjs";
import { totp } from "../lib/totp.mjs";

const DEFAULT_SIGNIN_URL = "https://training.knowbe4.com/";
// SCIM settings live under the account settings area; path is best-effort (KnowBe4 has moved it between
// "Account Settings → Users → SCIM" and "Account Integrations"). We navigate by clicking, not by URL.
const DEFAULT_APP_NAME = "iam-engine";

// Region → SCIM base URL. The console host tells us the region; the SCIM base is what the runner module
// (Coretelligent.KnowBe4) connects to. US is the default when the host is the training. domain.
const REGION_BASE = {
  us: "https://training.knowbe4.com/scim/v2",
  eu: "https://eu.knowbe4.com/scim/v2",
  ca: "https://ca.knowbe4.com/scim/v2",
};

// Resilient selectors for KnowBe4's login (ids are not publicly stable — small unions, semantic first).
const K = {
  email: 'input[type="email"], input[name="email"], input#email, input[name="user[email]"], input[autocomplete="username"], input[placeholder*="mail" i]',
  password: 'input[type="password"], input[name="password"], input#password, input[name="user[password]"], input[autocomplete="current-password"]',
  next: 'button[type="submit"], button:has-text("Log In"), button:has-text("Login"), button:has-text("Sign In"), button:has-text("Sign in"), button:has-text("Continue"), input[type="submit"]',
  totp: 'input[autocomplete="one-time-code"], input[name*="otp" i], input[name*="code" i], input[id*="code" i], input[inputmode="numeric"]',
  totpNext: 'button[type="submit"], button:has-text("Verify"), button:has-text("Submit"), button:has-text("Continue")',
  error: '[role="alert"]:visible, .error:visible, [class*="error" i]:visible, [aria-live="assertive"]:visible',
};

// SCIM token surface (Account Settings → User Management → SCIM, best-effort).
const S = {
  // Nav: the account settings gear/menu, then the SCIM/User-Management section.
  accountSettings: 'a[href*="account_settings" i], a[href*="settings" i], a:has-text("Account Settings"), button:has-text("Account Settings")',
  scimSection: 'a:has-text("SCIM"), button:has-text("SCIM"), a:has-text("User Provisioning"), a:has-text("User Management"), [href*="scim" i]',
  // Enable the SCIM/provisioning integration if it isn't already on.
  enableToggle: 'button:has-text("Enable"), input[type="checkbox"][name*="scim" i], [role="switch"]',
  // Generate/reveal the bearer token.
  generateBtn: 'button:has-text("Generate"), button:has-text("Create Token"), button:has-text("New Token"), button:has-text("Regenerate")',
  // The token value — a readonly input, <code>, or a copy-to-clipboard field.
  tokenField: 'input[readonly][value], input[id*="token" i], input[name*="token" i], code:has-text("Bearer"), [data-testid*="token" i], textarea[readonly]',
  copyable: 'input[readonly], code, textarea[readonly], [class*="copyable" i]',
};

// -------------------------------------------------------------------------------------------------
// PURE HELPERS (unit-tested; no browser)
// -------------------------------------------------------------------------------------------------

// Does `urlStr` look like a signed-in KnowBe4 page (past the sign-in screen)? True on a knowbe4 host
// whose path isn't a /login|/signin route. Tolerant: a non-URL yields false.
export function looksSignedIn(urlStr) {
  try {
    const u = new URL(urlStr);
    if (!/knowbe4\.com$/i.test(u.hostname)) return false;
    if (/(^|\/)(login|signin|logon|sso|authenticate)(\/|$)/i.test(u.pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

// Map a console host to its SCIM base URL (region inference). Defaults to US.
export function scimBaseForHost(urlStr) {
  try {
    const h = new URL(urlStr).hostname.toLowerCase();
    if (h.startsWith("eu.")) return REGION_BASE.eu;
    if (h.startsWith("ca.")) return REGION_BASE.ca;
    return REGION_BASE.us;
  } catch {
    return REGION_BASE.us;
  }
}

// The harvested token is present + non-empty. Used to decide success without logging it.
export function harvestComplete(h) {
  return Boolean(h && h.scimToken);
}

// -------------------------------------------------------------------------------------------------
// SIGN-IN (bespoke — KnowBe4's own login, not MS SSO)
// -------------------------------------------------------------------------------------------------
async function mintOtp(otpReq, log) {
  try {
    if (otpReq?.otpCode) return String(otpReq.otpCode);
    if (otpReq?.totpSeed) return totp(otpReq.totpSeed);
  } catch (e) {
    log?.(`could not generate the KnowBe4 TOTP code: ${e?.message ?? e}`);
  }
  return "";
}

async function signInKnowBe4({ page, shot, input, log }) {
  const username = input?.username;
  const password = input?.password;
  const signinUrl = input?.params?.consoleUrl?.trim() || DEFAULT_SIGNIN_URL;
  log(`navigating to KnowBe4 sign-in (${signinUrl})`);
  await page.goto(signinUrl, { waitUntil: "domcontentloaded" });

  // Email — wait for a real (active-view) field before filling, using the shared hidden-view discipline.
  const emailField = page.locator(K.email).first();
  if (await waitForCondition(page, () => onActiveView(emailField), 15000)) {
    await emailField.fill(username);
    await page.locator(K.next).first().click().catch(() => {});
  }
  // Password (may be the same page or a second step).
  const pwField = page.locator(K.password).first();
  if (!(await waitForCondition(page, () => onActiveView(pwField), 15000))) {
    const earlyErr = await page.locator(K.error).first().innerText().catch(() => "");
    throw new Error(`KnowBe4 never showed a usable password field${earlyErr ? ` — ${earlyErr.trim().slice(0, 200)}` : ""}`);
  }
  await pwField.fill(password);
  await page.locator(K.next).first().click().catch(() => {});
  await shot("after-credentials");

  // Optional TOTP.
  const otpField = page.locator(K.totp).first();
  if (await onActiveView(otpField)) {
    const code = await mintOtp(input?.params?.otp, log);
    if (!code) throw new Error("KnowBe4 prompted for an authenticator code but no TOTP seed/OTP was available");
    log("entering the authenticator (TOTP) code");
    await otpField.fill(code);
    await page.locator(K.totpNext).first().click().catch(() => {});
    await shot("after-totp");
  }

  // Confirm we cleared the login screen.
  await waitForCondition(page, () => looksSignedIn(page.url()), 30000);
  if (!looksSignedIn(page.url())) {
    const err = await page.locator(K.error).first().innerText().catch(() => "");
    throw new Error(`KnowBe4 sign-in did not complete${err ? ` — ${err.trim().slice(0, 200)}` : " (still on the login screen)"}`);
  }
  log("signed in to KnowBe4");
}

// -------------------------------------------------------------------------------------------------
// SCIM token create/harvest
// -------------------------------------------------------------------------------------------------
async function harvestScimToken({ page, shot, log }) {
  log("navigating to Account Settings → SCIM");
  await page.locator(S.accountSettings).first().click().catch(() => {});
  await page.locator(S.scimSection).first().click().catch(() => {});
  await shot("scim-section");

  // Enable the integration if a toggle is present and off (best-effort — harmless if already on).
  const toggle = page.locator(S.enableToggle).first();
  if (await toggle.isVisible().catch(() => false)) {
    await toggle.click().catch(() => {});
    log("clicked the SCIM enable control");
  }

  // Generate/reveal the token.
  const gen = page.locator(S.generateBtn).first();
  if (await gen.isVisible().catch(() => false)) {
    await gen.click().catch(() => {});
    log("clicked Generate token");
    await shot("token-generated");
  }

  // Read the token value from a readonly field / code element.
  let scimToken = "";
  const tf = page.locator(S.tokenField).first();
  if (await tf.count().catch(() => 0)) {
    scimToken = (await tf.inputValue().catch(() => "")) || (await tf.textContent().catch(() => "")) || "";
    scimToken = scimToken.replace(/^Bearer\s+/i, "").trim();
  }
  if (!scimToken) {
    // Fall back to scanning copyable fields for a token-shaped value.
    const vals = await page.locator(S.copyable).allTextContents().catch(() => []);
    const hit = vals.map((s) => s.replace(/^Bearer\s+/i, "").trim()).find((s) => /^[A-Za-z0-9._-]{20,}$/.test(s));
    if (hit) scimToken = hit;
  }
  if (!scimToken) throw new Error("could not read a SCIM token from the KnowBe4 SCIM settings page (selectors need live validation)");
  return { scimToken, baseUrl: scimBaseForHost(page.url()) };
}

// -------------------------------------------------------------------------------------------------
// ENTRY
// -------------------------------------------------------------------------------------------------
export default async function knowbe4ConsoleSetup({ page, input, shot, log }) {
  await signInKnowBe4({ page, shot, input, log });
  if (input?.params?.signInOnly !== false) {
    return { ok: true, message: "signed in to KnowBe4 (sign-in test only)" };
  }
  const harvested = await harvestScimToken({ page, shot, log });
  log(`harvested a SCIM token (${harvested.scimToken.length} chars) — base ${harvested.baseUrl}`);
  return { ok: true, message: "created/read the KnowBe4 SCIM token", harvested };
}
