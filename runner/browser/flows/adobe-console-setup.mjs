// Flow: adobe-console-setup
// ---------------------------------------------------------------------------------------------
// Sign in to the Adobe Developer Console (developer.adobe.com/console) with an Adobe admin (Adobe ID /
// federated email + password, TOTP cleared at the prompt), then create/open the "iam-engine" project,
// add the User Management API as an OAuth Server-to-Server credential, and HARVEST its Client ID,
// Client Secret, and Organization ID (…@AdobeOrg). Returns them in the result; the runner wraps them in
// a `Credentials` note-property (never logged) that the app vaults to Delinea.
//
// Modeled on the Mimecast console flow (mimecast-console-signin.mjs): Adobe's is its OWN login, not
// Microsoft SSO, so it uses a bespoke email → Next → password → Next → (TOTP) sequence with the shared
// hidden-element discipline (onActiveView / waitForCondition) — a SPA login pre-renders later views, so
// isVisible() lies; assert a real, non-aria-hidden field before typing.
//
// LIVE-VALIDATION PENDING: this flow has NOT been exercised against the live Adobe Developer Console (no
// Chromium in this environment, and Adobe's login + Developer Console DOM are unverified). EVERY
// selector is resilient best-effort — a small union tagged with its console location — and every step
// logs which stage it reached so a live run pinpoints the first wrong selector. The pure helper
// (looksSignedIn) is unit-tested. Validate end-to-end via the guided-setup modal before trusting it.
import { onActiveView, waitForCondition } from "../lib/ms-sso-login.mjs";
import { totp } from "../lib/totp.mjs";

const DEFAULT_CONSOLE_URL = "https://developer.adobe.com/console";

// Resilient selectors. Adobe's field ids aren't publicly stable, so each is a small union.
const M = {
  email: 'input[type="email"], input[name="username"], input#EmailPage-EmailField, input[name="email"], input[autocomplete="username"]',
  password: 'input[type="password"], input[name="password"], input#PasswordPage-PasswordField, input[autocomplete="current-password"]',
  next: 'button[type="submit"], button[data-id="EmailPage-ContinueButton"], button:has-text("Continue"), button:has-text("Next"), button:has-text("Sign in"), button:has-text("Sign In")',
  totp: 'input[autocomplete="one-time-code"], input[name*="otp" i], input[name*="code" i], input[id*="code" i], input[inputmode="numeric"]',
  totpNext: 'button[type="submit"], button:has-text("Verify"), button:has-text("Continue"), button:has-text("Submit")',
  error: '[role="alert"]:visible, .error:visible, [class*="error" i]:visible, [aria-live="assertive"]:visible',
};

// Developer-Console / create-credential route. All BEST-EFFORT (unverified DOM).
const A = {
  createProject: 'button:has-text("Create new project"), a:has-text("Create new project"), button:has-text("Create project")',
  projectRow: (name) => `a:has-text("${name}"), [role="row"]:has-text("${name}"), h2:has-text("${name}")`,
  addApi: 'button:has-text("Add API"), a:has-text("Add API"), button:has-text("Add to Project")',
  userMgmtApi: 'text="User Management API", label:has-text("User Management API"), [aria-label*="User Management" i]',
  oauthS2S: 'text="OAuth Server-to-Server", label:has-text("OAuth Server-to-Server"), input[value*="server-to-server" i]',
  saveConfigured: 'button:has-text("Save configured API"), button:has-text("Save"), button[type="submit"]',
  // The generated credential's Overview — Client ID / Client Secret / Organization ID.
  retrieveSecret: 'button:has-text("Retrieve client secret"), button:has-text("Retrieve"), button:has-text("Copy"):near(:text("Client Secret"))',
  clientId: '[data-testid*="client-id" i], [aria-label*="Client ID" i], dt:has-text("Client ID") + dd, input[readonly][value]',
  clientSecret: '[data-testid*="client-secret" i], [aria-label*="Client Secret" i], dt:has-text("Client Secret") + dd',
  orgId: '[data-testid*="org-id" i], [aria-label*="Organization ID" i], dt:has-text("Organization ID") + dd, :text("@AdobeOrg")',
};

// -------------------------------------------------------------------------------------------------
// PURE HELPER (unit-tested; no browser)
// -------------------------------------------------------------------------------------------------
// Does `urlStr` look like a signed-in Adobe Developer Console page (past the Adobe ID login)? True when
// on an adobe.com host that is NOT an auth/ims host and whose path isn't a /sign-in|/auth route.
export function looksSignedIn(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { return false; }
  const host = u.hostname.toLowerCase();
  if (!/(^|\.)adobe\.com$/.test(host)) return false;
  if (/^(auth|ims|ims-na1|adobeid|signin)\./.test(host)) return false; // still on an Adobe ID auth host
  if (/\/(sign-?in|log-?in|auth)(\/|$)/i.test(u.pathname)) return false;
  return true;
}

// -------------------------------------------------------------------------------------------------
// BROWSER PATH (LIVE-VALIDATION PENDING)
// -------------------------------------------------------------------------------------------------

// Mint a CURRENT one-time password from the app AT the code box (a TOTP lives ~30s). Never logs it.
async function mintOtp(otpReq, log) {
  if (!otpReq?.url) return null;
  try {
    const res = await fetch(otpReq.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "true", ...(otpReq.token ? { Authorization: `Bearer ${otpReq.token}` } : {}) },
      body: JSON.stringify({ agentId: otpReq.agentId, secretName: otpReq.secretName, otp: true }),
    });
    if (!res.ok) { log(`could not mint a one-time password (HTTP ${res.status})`); return null; }
    const d = await res.json().catch(() => null);
    if (!d?.otpCode) { log(`no one-time password available${d?.otpError ? `: ${d.otpError}` : ""}`); return null; }
    log(`one-time password minted (${d.otpRemainingSeconds ?? "?"}s valid)`);
    return String(d.otpCode);
  } catch (e) { log(`could not mint a one-time password: ${e?.message ?? e}`); return null; }
}

async function readError(page) {
  const box = page.locator(M.error).first();
  if (!(await box.isVisible().catch(() => false))) return null;
  const t = await box.innerText().catch(() => null);
  return t && t.trim() ? t.trim().split("\n")[0] : null;
}

// Clear a TOTP second factor when challenged. Returns { done:true } or { bail:err }.
async function handleSecondFactor(page, shot, mfa, log) {
  try {
    const totpField = page.locator(M.totp).first();
    if (!(await onActiveView(totpField))) return { done: true };
    const produce = async () => {
      if (mfa.otpReq) { const c = await mintOtp(mfa.otpReq, log); if (c) return c; }
      if (mfa.totpSeed) { try { return totp(mfa.totpSeed); } catch { return null; } }
      return null;
    };
    let last = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      let code = await produce();
      for (let hop = 0; hop < 4 && code && last && code === last; hop++) { await page.waitForTimeout(8000); code = await produce(); }
      if (!code) return { bail: { ok: false, error: "Adobe requires a verification code but none was available — enable One-Time Password on the 'adobe-console' secret in Delinea (an authenticator app, not push/SMS), or complete the sign-in manually.", evidence: await shot("adobe-mfa-no-code") } };
      last = code;
      log(attempt === 0 ? "entering the verification code" : "code rejected — retrying once with a fresh code"); // never log the code
      await totpField.fill(code);
      await page.locator(M.totpNext).first().click().catch(() => {});
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(2500);
      if (!(await page.locator(M.totp).first().isVisible().catch(() => false))) return { done: true };
    }
    try { await page.locator(M.totp).first().fill(""); } catch { /* gone */ }
    return { bail: { ok: false, error: "the Adobe verification code was rejected — re-pair the authenticator into the secret's One-Time Password in Delinea.", evidence: await shot("adobe-totp-rejected") } };
  } catch (e) {
    return { bail: { ok: false, error: `second-factor handling failed: ${e?.message ?? e}`, evidence: await shot("adobe-mfa-error") } };
  }
}

// Adobe ID sign-in: email -> Continue -> password -> Sign in -> (TOTP). Returns { ok:true } once in the
// console, else { ok:false, error, evidence }.
async function signInAdobe({ page, shot, input, log }) {
  const username = input?.username ?? null;
  const password = input?.password ?? null; // NEVER logged
  const mfa = { otpReq: input?.params?.otp ?? null, totpSeed: input?.params?.totpSeed ?? input?.totpSeed ?? null };
  if (!username || !password) return { ok: false, error: "no Adobe console credentials brokered (username/password) — wire the 'adobe-console' secret with an Adobe admin email + password." };
  try {
    const emailField = page.locator(M.email).first();
    if (await waitForCondition(page, () => onActiveView(emailField), 20_000)) {
      log("entering the Adobe admin email");
      await emailField.fill(username);
      await page.locator(M.next).first().click().catch(() => {});
      await page.waitForLoadState("domcontentloaded").catch(() => {});
    }
    const pwField = page.locator(M.password).first();
    const gotPw = await waitForCondition(page, async () => (await onActiveView(pwField)) || (await readError(page)) != null || looksSignedIn(page.url()), 20_000);
    const earlyErr = await readError(page);
    if (earlyErr) return { ok: false, error: `Adobe rejected the sign-in: ${earlyErr}`, evidence: await shot("adobe-email-error") };
    if (looksSignedIn(page.url())) return { ok: true };
    if (!gotPw || !(await onActiveView(pwField))) return { ok: false, error: "could not reach the Adobe password field — VERIFY the sign-in selectors against the live Adobe ID login (it may be federated SSO for this org).", evidence: await shot("adobe-no-password") };
    log("entering the Adobe admin password"); // the VALUE is never logged
    await pwField.fill(password);
    await page.locator(M.next).first().click().catch(() => {});
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(2000);
    const pwErr = await readError(page);
    if (pwErr) return { ok: false, error: `Adobe rejected the sign-in: ${pwErr}`, evidence: await shot("adobe-password-error") };

    const sf = await handleSecondFactor(page, shot, mfa, log);
    if (sf.bail) return sf.bail;

    const signedIn = await waitForCondition(page, () => looksSignedIn(page.url()), 15_000);
    if (!signedIn) return { ok: false, error: "sign-in completed the password/code steps but did not reach the Developer Console — VERIFY the flow / an unexpected interstitial (this org may use federated SSO).", evidence: await shot("adobe-no-console") };
  } catch (e) {
    return { ok: false, error: `Adobe sign-in failed: ${e?.message ?? e}`, evidence: await shot("adobe-login-error") };
  }
  return { ok: true };
}

// Read a value from a locator (input value or inner text), trimmed, or "".
async function readValue(page, selector) {
  const el = page.locator(selector).first();
  if (!(await el.isVisible().catch(() => false))) return "";
  const v = await el.inputValue().catch(() => null);
  if (v && v.trim()) return v.trim();
  const t = await el.innerText().catch(() => null);
  return t && t.trim() ? t.trim() : "";
}

// Create/open the "iam-engine" project, add the User Management API as OAuth Server-to-Server, and
// harvest the credential. BEST-EFFORT selectors. Returns { ok:true, clientId, clientSecret, orgId } or
// { ok:false, error, evidence }.
async function createApiCredential({ page, shot, input, log, projectName }) {
  try {
    log("opening the Adobe Developer Console projects");
    await page.goto(`${input?.params?.consoleUrl ?? DEFAULT_CONSOLE_URL}/projects`, { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(1500);

    // Idempotency: reuse an existing "iam-engine" project if present; else create one.
    const existing = page.locator(A.projectRow(projectName)).first();
    if (await existing.isVisible().catch(() => false)) {
      log(`project "${projectName}" already exists — opening it`);
      await existing.click().catch(() => {});
    } else {
      log(`creating project "${projectName}"`);
      const create = page.locator(A.createProject).first();
      if (!(await create.isVisible().catch(() => false))) return { ok: false, error: "could not find 'Create new project' — VERIFY the Developer Console selectors against a live account.", evidence: await shot("adobe-no-create-project") };
      await create.click().catch(() => {});
    }
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(1500);

    // Add API -> User Management API -> OAuth Server-to-Server -> Save.
    log("adding the User Management API (OAuth Server-to-Server)");
    const addApi = page.locator(A.addApi).first();
    if (!(await addApi.isVisible().catch(() => false))) return { ok: false, error: "could not find 'Add API' in the project — VERIFY the selector against the live console.", evidence: await shot("adobe-no-add-api") };
    await addApi.click().catch(() => {});
    await page.waitForTimeout(1200);
    await page.locator(A.userMgmtApi).first().click().catch(() => {});
    await page.locator(M.next).first().click().catch(() => {});
    await page.waitForTimeout(800);
    await page.locator(A.oauthS2S).first().click().catch(() => {});
    await page.locator(M.next).first().click().catch(() => {});
    await page.waitForTimeout(800);
    await page.locator(A.saveConfigured).first().click().catch(() => {});
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(2000);

    // Harvest. Retrieve the (shown-once) client secret, then read the three values.
    await page.locator(A.retrieveSecret).first().click().catch(() => {});
    await page.waitForTimeout(1000);
    const clientId = await readValue(page, A.clientId);
    const clientSecret = await readValue(page, A.clientSecret);
    let orgId = await readValue(page, A.orgId);
    if (orgId && !/@AdobeOrg$/.test(orgId)) { const m = orgId.match(/[A-F0-9]+@AdobeOrg/i); orgId = m ? m[0] : orgId; }

    if (!clientId || !clientSecret) {
      return { ok: false, error: "created the credential but could not read the Client ID / Client Secret from the Overview — VERIFY the harvest selectors against the live console, or paste the credential manually.", evidence: await shot("adobe-no-harvest") };
    }
    log("harvested the OAuth Server-to-Server credential"); // NEVER log the values
    return { ok: true, harvested: { clientId, clientSecret, ...(orgId ? { orgId } : {}) } };
  } catch (e) {
    return { ok: false, error: `creating the Adobe API credential failed: ${e?.message ?? e}`, evidence: await shot("adobe-create-error") };
  }
}

// -------------------------------------------------------------------------------------------------
// FLOW ENTRY
// -------------------------------------------------------------------------------------------------
export default async function adobeConsoleSetup({ page, shot, input, log }) {
  const consoleUrl = input?.params?.consoleUrl ?? DEFAULT_CONSOLE_URL;
  const signInOnly = input?.params?.signInOnly === true;
  try {
    log("navigating to the Adobe Developer Console sign-in");
    await page.goto(consoleUrl, { waitUntil: "domcontentloaded" });
  } catch (e) {
    return { ok: false, error: `could not reach the Adobe Developer Console (${consoleUrl}): ${e?.message ?? e}`, evidence: await shot("adobe-nav") };
  }

  const signIn = await signInAdobe({ page, shot, input, log });
  if (!signIn.ok) return signIn;
  if (signInOnly) return { ok: true, message: "signed in to the Adobe Developer Console" };

  const projectName = input?.params?.appName || "iam-engine";
  return createApiCredential({ page, shot, input, log, projectName });
}
