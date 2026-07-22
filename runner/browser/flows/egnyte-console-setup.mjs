// Flow: egnyte-console-setup
// ---------------------------------------------------------------------------------------------
// Sign in to a client's Egnyte admin console (from an `egnyte-console` email+password login, clearing
// a TOTP prompt by minting the code at the prompt) and harvest a domain API token — the `egnyte` API
// credential (Egnyte domain + API token). Modeled directly on runner/browser/flows/
// zoom-console-setup.mjs / mimecast-console-signin.mjs (Phase 2): the runner harvests the shown token
// and returns it note-only; the APP vaults it to Delinea. `params.signInOnly:true` proves the login
// works and changes nothing (the "Test sign-in" affordance).
//
// The Egnyte DOMAIN (the <domain> in https://<domain>.egnyte.com) is a KNOWN input (params.egnyteDomain),
// not something harvested — the flow echoes it back in `harvested` so the app can vault {domain, token}
// symmetrically. Only the API token is read from the console.
//
// This is Egnyte's OWN login, NOT M365 SSO — a bespoke sign-in (email -> Next -> password -> Next ->
// optional TOTP), reusing the shared hidden-view discipline (onActiveView / waitForCondition).
//
// LIVE-VALIDATION PENDING: never exercised against a live Egnyte console (no Chromium here, and the
// Egnyte sign-in + admin API-token DOM are unverified). Every selector is a resilient best-effort union
// in this directory's style, tagged with its console location, and each step logs which stage it reached
// so a live run pinpoints the first wrong selector. The harvested token is NEVER logged. Note: an Egnyte
// account behind SSO will not accept an email+password login — those tenants must paste the token via
// the guided form instead.
import { onActiveView, waitForCondition } from "../lib/ms-sso-login.mjs";
import { totp } from "../lib/totp.mjs";

const DEFAULT_APP_NAME = "iam-engine";

// Resilient selectors for Egnyte's login (ids are not publicly stable — small unions, semantic first).
const E = {
  email: 'input[type="email"], input[name="email"], input#email, input[name="username"], input[autocomplete="username"], input[placeholder*="mail" i]',
  password: 'input[type="password"], input[name="password"], input#password, input[autocomplete="current-password"]',
  next: 'button[type="submit"], button:has-text("Next"), button:has-text("Continue"), button:has-text("Sign In"), button:has-text("Sign in"), button:has-text("Log In"), input[type="submit"]',
  totp: 'input[autocomplete="one-time-code"], input[name*="otp" i], input[name*="code" i], input[id*="code" i], input[inputmode="numeric"]',
  totpNext: 'button[type="submit"], button:has-text("Verify"), button:has-text("Submit"), button:has-text("Continue")',
  error: '[role="alert"]:visible, .error:visible, [class*="error" i]:visible, [aria-live="assertive"]:visible',
};

// API-token surface. Egnyte exposes domain tokens under Settings → Configuration → API Keys/Tokens
// (admin console), or at developers.egnyte.com. Best-effort nav + read.
const A = {
  // Admin settings / API area entry points (try in order; nav is also attempted by URL below).
  settingsLink: 'a:has-text("Settings"), a[href*="settings" i], nav a:has-text("Admin")',
  apiLink: 'a:has-text("API Keys"), a:has-text("API Tokens"), a:has-text("Keys & Tokens"), a:has-text("API"), a[href*="api" i], a[href*="token" i]',
  generateBtn: 'button:has-text("Generate"), button:has-text("Create Token"), button:has-text("New Token"), button:has-text("Create API Key"), a:has-text("Generate")',
  // The generated token as a read-only / copyable field.
  tokenField: '[aria-label*="token" i], [aria-label*="api key" i], input[readonly][id*="token" i], input[readonly][id*="key" i], [data-testid*="token" i], code',
  copyable: 'input[readonly], code, textarea[readonly], [class*="copyable" i], [class*="token" i]',
};

// -------------------------------------------------------------------------------------------------
// PURE HELPERS (unit-tested; no browser)
// -------------------------------------------------------------------------------------------------

// Build the Egnyte admin sign-in URL for a domain. Accepts a bare subdomain ("drakestar"), a full host
// ("drakestar.egnyte.com"), or a full URL — always returns an https egnyte.com URL. Empty -> "".
export function egnyteConsoleUrl(domain) {
  const d = (domain ?? "").trim();
  if (!d) return "";
  if (/^https?:\/\//i.test(d)) return d;
  const host = d.includes(".") ? d : `${d}.egnyte.com`;
  return `https://${host}/`;
}

// Does `urlStr` look like a signed-in Egnyte page (past the sign-in screen)? True on an egnyte.com host
// whose path isn't a login route. Tolerant: a non-URL yields false.
export function looksSignedIn(urlStr) {
  try {
    const u = new URL(urlStr);
    if (!u.hostname.toLowerCase().endsWith("egnyte.com")) return false;
    if (/(^|\/)(signin|login|logon|sso|auth)(\/|$)/i.test(u.pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

// The token was harvested (present + plausibly long). Used to decide success without logging it.
export function harvestComplete(h) {
  return Boolean(h && typeof h.token === "string" && h.token.trim().length > 8);
}

// -------------------------------------------------------------------------------------------------
// SIGN-IN (bespoke — Egnyte's own login, not MS SSO)
// -------------------------------------------------------------------------------------------------
async function mintOtp(otpReq, log) {
  try {
    if (otpReq?.otpCode) return String(otpReq.otpCode);
    if (otpReq?.totpSeed) return totp(otpReq.totpSeed);
  } catch (e) {
    log?.(`could not generate the Egnyte TOTP code: ${e?.message ?? e}`);
  }
  return "";
}

async function signInEgnyte({ page, shot, input, log }) {
  const username = input?.username;
  const password = input?.password;
  if (!username || !password) {
    return { ok: false, error: "no Egnyte console credentials brokered (email/password) — wire an 'egnyte-console' secret with an admin email + password." };
  }
  try {
    const emailField = page.locator(E.email).first();
    if (await waitForCondition(() => onActiveView(emailField), 15000)) {
      await emailField.fill(username);
      await page.locator(E.next).first().click().catch(() => {});
      await page.waitForTimeout(1200);
    }
    if (looksSignedIn(page.url())) return { ok: true }; // existing session

    const pwField = page.locator(E.password).first();
    if (!(await waitForCondition(() => onActiveView(pwField), 15000))) {
      return { ok: false, error: "could not reach the Egnyte password field — VERIFY the sign-in selectors against the live console (or the account may be SSO-only).", evidence: await shot("egnyte-no-password") };
    }
    await pwField.fill(password);
    await page.locator(E.next).first().click().catch(() => {});
    await page.waitForTimeout(1800);

    const earlyErr = await page.locator(E.error).first().innerText().catch(() => "");
    if (earlyErr && !looksSignedIn(page.url())) {
      return { ok: false, error: `Egnyte rejected the sign-in: ${earlyErr.trim()}`, evidence: await shot("egnyte-password-error") };
    }

    // Optional TOTP second factor.
    const otpField = page.locator(E.totp).first();
    if (await onActiveView(otpField)) {
      const code = await mintOtp(input?.params?.otp, log);
      if (!code) {
        return { ok: false, error: "Egnyte asked for a verification code but none was available — enable One-Time Password on the 'egnyte-console' secret in Delinea, or complete the sign-in manually.", evidence: await shot("egnyte-mfa-no-code") };
      }
      await otpField.fill(code);
      await page.locator(E.totpNext).first().click().catch(() => {});
      await page.waitForTimeout(2000);
      const otpErr = await page.locator(E.error).first().innerText().catch(() => "");
      if (otpErr && !looksSignedIn(page.url())) {
        return { ok: false, error: `the Egnyte verification code was rejected: ${otpErr.trim()}`, evidence: await shot("egnyte-mfa-rejected") };
      }
    }

    if (!looksSignedIn(page.url())) {
      return { ok: false, error: "the sign-in completed the password/code steps but did not reach a signed-in Egnyte page — VERIFY the flow / an unexpected interstitial against the live console.", evidence: await shot("egnyte-no-console") };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Egnyte sign-in failed: ${e?.message ?? e}`, evidence: await shot("egnyte-login-error") };
  }
}

// -------------------------------------------------------------------------------------------------
// HARVEST THE API TOKEN (LIVE-VALIDATION PENDING)
// -------------------------------------------------------------------------------------------------
async function readToken(page) {
  const readVal = async (loc) => {
    const el = page.locator(loc).first();
    if (!(await el.count().catch(() => 0))) return "";
    return ((await el.inputValue().catch(() => "")) || (await el.getAttribute("value").catch(() => "")) || (await el.innerText().catch(() => "")) || "").trim();
  };
  let token = await readVal(A.tokenField);
  if (!token || token.length < 9) {
    // Fallback: scan read-only/copyable fields for the longest token-shaped string.
    const ro = page.locator(A.copyable);
    const n = await ro.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const v = ((await ro.nth(i).inputValue().catch(() => "")) || (await ro.nth(i).innerText().catch(() => ""))).trim();
      if (v && v.length > (token?.length ?? 0) && /^[A-Za-z0-9._-]{9,}$/.test(v)) token = v;
    }
  }
  return token;
}

async function harvestToken({ page, shot, input, log, baseUrl }) {
  try {
    // 1. Navigate toward the API-token surface. Try common admin paths by URL, then link fallbacks.
    log("navigating to the Egnyte API token surface");
    const candidates = [`${baseUrl}app/settings/keys`, `${baseUrl}app/settings/api`, `${baseUrl}app/admin/apikeys`];
    for (const url of candidates) {
      await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForTimeout(1000);
      if (await page.locator(A.generateBtn).first().isVisible().catch(() => false)) break;
      if (await page.locator(A.tokenField).first().isVisible().catch(() => false)) break;
    }
    // Link-based fallback if URL nav didn't land on the token page.
    if (!(await page.locator(A.tokenField).first().isVisible().catch(() => false))) {
      for (const sel of [A.settingsLink, A.apiLink]) {
        const link = page.locator(sel).first();
        if (await link.isVisible().catch(() => false)) { await link.click().catch(() => {}); await page.waitForTimeout(1200); }
      }
    }

    // 2. Generate a token if there's a generate/create control (reuse an existing one otherwise).
    const gen = page.locator(A.generateBtn).first();
    if (await gen.isVisible().catch(() => false)) {
      await gen.click().catch(() => {});
      await page.waitForTimeout(1500);
    }

    // 3. Read the token.
    log("reading the Egnyte API token"); // value NEVER logged
    const token = await readToken(page);
    if (!token || token.length < 9) {
      return { ok: false, error: "signed in but the Egnyte API token could not be read — VERIFY the API-token selectors against the live admin console (token generation may require registering an API application at developers.egnyte.com first).", evidence: await shot("egnyte-no-token") };
    }
    return { ok: true, message: "harvested the Egnyte API token", token };
  } catch (e) {
    return { ok: false, error: `Egnyte token harvest failed: ${e?.message ?? e}`, evidence: await shot("egnyte-harvest-error") };
  }
}

// -------------------------------------------------------------------------------------------------
// ENTRY
// -------------------------------------------------------------------------------------------------
export default async function egnyteConsoleSetup({ page, shot, input, log }) {
  const signInOnly = input?.params?.signInOnly !== false; // default sign-in-only
  const domain = (input?.params?.egnyteDomain && String(input.params.egnyteDomain).trim()) || "";
  const signinUrl = (input?.params?.consoleUrl && String(input.params.consoleUrl).trim()) || egnyteConsoleUrl(domain);
  if (!signinUrl) {
    return { ok: false, error: "no Egnyte domain provided — the flow needs the client's Egnyte subdomain to sign in." };
  }
  const baseUrl = signinUrl.endsWith("/") ? signinUrl : `${signinUrl}/`;

  try {
    await page.goto(signinUrl, { waitUntil: "domcontentloaded" });
  } catch (e) {
    return { ok: false, error: `could not reach the Egnyte sign-in (${signinUrl}): ${e?.message ?? e}`, evidence: await shot("nav") };
  }

  const signIn = await signInEgnyte({ page, shot, input, log });
  if (!signIn.ok) return signIn;

  if (signInOnly) return { ok: true, message: "signed in to Egnyte" };

  const h = await harvestToken({ page, shot, input, log, baseUrl });
  if (!h.ok) return h;
  // Echo the known domain back with the harvested token so the app vaults {domain, token} symmetrically.
  return { ok: true, message: h.message, harvested: { domain, token: h.token } };
}
