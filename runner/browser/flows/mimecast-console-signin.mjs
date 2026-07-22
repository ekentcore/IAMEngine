// Flow: mimecast-console-signin
// ---------------------------------------------------------------------------------------------
// Sign in to the Mimecast Administration Console (login.mimecast.com) with a Mimecast admin email +
// password, clearing a TOTP second factor by minting the code AT the prompt. Phase 1 is SIGN-IN ONLY
// (params.signInOnly): it proves the console login + MFA work and reports success — it creates
// nothing. (Phase 2 will continue past sign-in to create the API 2.0 application and harvest its
// Client ID/Secret; this file grows a create-app path then.)
//
// This is Mimecast's OWN login, NOT Microsoft 365 SSO — so it does not use lib/ms-sso-login's
// signInMicrosoft; it is modeled on the Google flow's bespoke signInGoogle (email -> Next ->
// password -> Next -> TOTP). We reuse the shared hidden-element discipline (onActiveView /
// waitForCondition): a SPA login pre-renders later views, so isVisible() lies — assert a real,
// non-aria-hidden, full-width field before typing, and detect the "typed the password, no
// navigation, no error" stall instead of blaming the credentials on a timeout.
//
// LIVE-VALIDATION PENDING: this flow has not been exercised against the live Mimecast console (no
// Chromium in this environment, and the console DOM/MFA UI is unverified). Selectors are resilient
// best-effort in this directory's style; the pure helper (looksSignedIn) is unit-tested. Validate
// against a real tenant via the guided-setup modal's "Test sign-in" button before trusting it.
import { onActiveView, waitForCondition } from "../lib/ms-sso-login.mjs";
import { totp } from "../lib/totp.mjs";

const DEFAULT_CONSOLE_URL = "https://login.mimecast.com/";

// Resilient selectors for Mimecast's login. Mimecast's field ids are not publicly stable, so each is
// a small union: the semantic type first, then common name/id/placeholder fallbacks.
const M = {
  email: 'input[type="email"], input[name="email"], input[name="username"], input#username, input[autocomplete="username"], input[placeholder*="mail" i]',
  password: 'input[type="password"], input[name="password"], input#password, input[autocomplete="current-password"]',
  // Mimecast's per-step continue/sign-in button.
  next: 'button[type="submit"], button:has-text("Next"), button:has-text("Continue"), button:has-text("Log In"), button:has-text("Login"), button:has-text("Sign In"), input[type="submit"]',
  // A TOTP / authenticator code box.
  totp: 'input[autocomplete="one-time-code"], input[name*="otp" i], input[name*="code" i], input[id*="otp" i], input[id*="code" i], input[inputmode="numeric"]',
  totpNext: 'button[type="submit"], button:has-text("Verify"), button:has-text("Submit"), button:has-text("Continue"), button:has-text("Next")',
  // Mimecast's inline sign-in error (wrong password / locked / rejected code).
  error: '[role="alert"]:visible, .error:visible, .alert-danger:visible, [class*="error" i]:visible, [aria-live="assertive"]:visible',
};

// -------------------------------------------------------------------------------------------------
// PURE HELPER (unit-tested; no browser)
// -------------------------------------------------------------------------------------------------

// Does `urlStr` look like a signed-in Mimecast console page (i.e. past the login screen)? True when
// the URL is on a mimecast.com host that is NOT the login host and whose path isn't a /login|/logon
// route. Used as the sign-in success signal — a page that is still on login.mimecast.com (or any
// */login path) means the sign-in hasn't completed. Tolerant: a non-URL yields false.
export function looksSignedIn(urlStr) {
  try {
    const u = new URL(urlStr);
    const host = u.hostname.toLowerCase();
    if (!host.endsWith("mimecast.com")) return false;
    if (host === "login.mimecast.com") return false;
    if (/(^|\/)(login|logon|signin|sso)(\/|$)/i.test(u.pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------------------------------------
// BROWSER PATH (LIVE-VALIDATION PENDING)
// -------------------------------------------------------------------------------------------------

// Mint a CURRENT one-time password from the app AT THE CODE BOX (a TOTP code lives ~30s and the
// sign-in hop outlives that). otpReq = { url, token, agentId, secretName }. Returns the code or null;
// never logs it. Mirrors the Google/MS flows' mintOtp exactly.
async function mintOtp(otpReq, log) {
  if (!otpReq?.url) return null;
  try {
    const res = await fetch(otpReq.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ngrok-skip-browser-warning": "true",
        ...(otpReq.token ? { Authorization: `Bearer ${otpReq.token}` } : {}),
      },
      body: JSON.stringify({ agentId: otpReq.agentId, secretName: otpReq.secretName, otp: true }),
    });
    if (!res.ok) { log(`could not mint a one-time password (HTTP ${res.status})`); return null; }
    const d = await res.json().catch(() => null);
    if (!d?.otpCode) { log(`no one-time password available${d?.otpError ? `: ${d.otpError}` : ""}`); return null; }
    log(`one-time password minted (${d.otpRemainingSeconds ?? "?"}s valid)`);
    return String(d.otpCode);
  } catch (e) {
    log(`could not mint a one-time password: ${e?.message ?? e}`);
    return null;
  }
}

// Blank the TOTP box before any evidence screenshot — unlike the password (dots), the code renders as
// legible plaintext and would be readable in the pixels of an attached screenshot.
async function scrubTotp(page) {
  try { await page.locator(M.totp).first().fill(""); } catch { /* gone/navigated */ }
}

// The visible Mimecast sign-in error text, or null (only when actually shown with text).
async function readMimecastError(page) {
  const box = page.locator(M.error).first();
  if (!(await box.isVisible().catch(() => false))) return null;
  const t = await box.innerText().catch(() => null);
  return t && t.trim() ? t.trim().split("\n")[0] : null;
}

// Clear the TOTP second factor when challenged. Returns { done:true } (past it / none) or { bail:err }.
// Freshest code first; a retry must submit a DIFFERENT code (within one 30s window the seed returns
// the same code), so wait out the window in short hops. Push/tap/SMS is a hard stop.
async function handleSecondFactor(page, shot, mfa, log) {
  try {
    const totpField = page.locator(M.totp).first();
    if (!(await onActiveView(totpField))) return { done: true }; // no code challenge

    let preMintedUsed = false;
    const produce = async () => {
      if (mfa.otpReq) { const c = await mintOtp(mfa.otpReq, log); if (c) return { code: c }; }
      if (mfa.otpCode && !preMintedUsed) { preMintedUsed = true; return { code: String(mfa.otpCode) }; }
      if (mfa.totpSeed) {
        try { return { code: totp(mfa.totpSeed) }; }
        catch (e) { return { err: `could not generate the TOTP code from the secret's seed: ${e?.message ?? e}` }; }
      }
      return null;
    };
    const nextCode = async (rejected) => {
      let next = await produce();
      for (let hop = 0; hop < 4 && next?.code && rejected && next.code === rejected; hop++) {
        log("fresh code is still the rejected one (same TOTP window) — waiting for the next window");
        await page.waitForTimeout(8000);
        next = await produce();
      }
      if (next?.code && rejected && next.code === rejected) return null;
      return next;
    };

    let lastCode = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const next = await nextCode(lastCode);
      if (next?.err) return { bail: { ok: false, error: next.err, evidence: await shot("totp-error") } };
      if (!next) {
        if (attempt > 0) break;
        return { bail: { ok: false, error: "Mimecast requires a verification code but none was available — enable One-Time Password on the 'mimecast-console' secret in Delinea (the runner mints a fresh code at the prompt), or complete the sign-in manually.", evidence: await shot("mfa-no-code") } };
      }
      lastCode = next.code;
      log(attempt === 0 ? "entering the verification code" : "code rejected — retrying once with a fresh code"); // never log the code
      await totpField.fill(next.code);
      await page.locator(M.totpNext).first().click().catch(() => {});
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(2500);
      if (!(await page.locator(M.totp).first().isVisible().catch(() => false))) return { done: true }; // accepted
    }
    await scrubTotp(page);
    return { bail: { ok: false, error: "the Mimecast verification code was rejected — re-pair the authenticator into the secret's One-Time Password in Delinea, and confirm the account uses an authenticator app (not a push/SMS prompt).", evidence: await shot("totp-rejected") } };
  } catch (e) {
    await scrubTotp(page);
    return { bail: { ok: false, error: `second-factor handling failed: ${e?.message ?? e}`, evidence: await shot("mfa-error") } };
  }
}

// Drive Mimecast's sign-in: email -> Next -> password -> Next -> (second factor). Returns { ok:true }
// once signed in (looksSignedIn(page.url()) or the login form is gone with no error), else
// { ok:false, error, evidence }. Exported so a future create-app flow can reuse the exact sign-in.
export async function signInMimecast({ page, shot, input, log }) {
  const username = input?.username ?? null;
  const password = input?.password ?? null; // NEVER logged
  const mfa = {
    otpReq: input?.params?.otp ?? null,
    otpCode: input?.params?.otpCode ?? null,
    totpSeed: input?.params?.totpSeed ?? input?.totpSeed ?? null,
  };
  if (!username || !password) {
    return { ok: false, error: "no Mimecast console credentials brokered (username/password) — wire the 'mimecast-console' secret with an admin email + password." };
  }

  try {
    // 1. Email step. Assert the field is on the ACTIVE view before typing.
    const emailField = page.locator(M.email).first();
    if (await waitForCondition(page, () => onActiveView(emailField), 20_000)) {
      log("entering the Mimecast admin email");
      await emailField.fill(username);
      await page.locator(M.next).first().click().catch(() => {});
      await page.waitForLoadState("domcontentloaded").catch(() => {});
    }

    // 2. Password step. Mimecast may show email+password on one page or split them; wait for the real
    //    password view (or an early error).
    const pwField = page.locator(M.password).first();
    const gotPw = await waitForCondition(page, async () => (await onActiveView(pwField)) || (await readMimecastError(page)) != null || looksSignedIn(page.url()), 20_000);
    const earlyErr = await readMimecastError(page);
    if (earlyErr) return { ok: false, error: `Mimecast rejected the sign-in: ${earlyErr}`, evidence: await shot("mimecast-email-error") };
    if (looksSignedIn(page.url())) return { ok: true }; // already through (e.g. an existing session)
    if (!gotPw || !(await onActiveView(pwField))) {
      return { ok: false, error: "could not reach the Mimecast password field — VERIFY the sign-in selectors against the live console.", evidence: await shot("no-password-field") };
    }
    log("entering the Mimecast admin password"); // the VALUE is never logged
    await pwField.fill(password);
    await page.locator(M.next).first().click().catch(() => {});
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(2000);

    // A rejected password re-renders with an error; an untouched, still-active password box means the
    // submit never took. Read the error BEFORE deciding it stalled (the MS/Google login lesson).
    const pwErr = await readMimecastError(page);
    if (pwErr) return { ok: false, error: `Mimecast rejected the sign-in: ${pwErr}`, evidence: await shot("mimecast-password-error") };
    if (!looksSignedIn(page.url()) && (await onActiveView(pwField))) {
      return { ok: false, error: "the password was entered but Mimecast's sign-in did not advance and showed no error — VERIFY the sign-in selectors / that the account isn't blocked.", evidence: await shot("password-no-advance") };
    }

    // 3. Second factor (the common case, after the password).
    const sf = await handleSecondFactor(page, shot, mfa, log);
    if (sf.bail) return sf.bail;

    const lateErr = await readMimecastError(page);
    if (lateErr) return { ok: false, error: `Mimecast rejected the sign-in: ${lateErr}`, evidence: await shot("mimecast-signin-error") };

    // 4. Confirm we actually landed in the console — wait briefly for the post-login navigation.
    const signedIn = await waitForCondition(page, () => looksSignedIn(page.url()), 15_000);
    if (!signedIn) {
      return { ok: false, error: "the sign-in completed the password + code steps but did not reach the Mimecast console — VERIFY the flow / an unexpected interstitial against the live console.", evidence: await shot("no-console") };
    }
  } catch (e) {
    return { ok: false, error: `Mimecast sign-in failed: ${e?.message ?? e}`, evidence: await shot("login-error") };
  }
  return { ok: true };
}

// -------------------------------------------------------------------------------------------------
// FLOW ENTRY
// -------------------------------------------------------------------------------------------------
export default async function mimecastConsoleSignin({ page, shot, input, log }) {
  const consoleUrl = input?.params?.consoleUrl ?? DEFAULT_CONSOLE_URL;
  const signInOnly = input?.params?.signInOnly !== false; // default to sign-in-only (Phase 1)

  try {
    log("navigating to the Mimecast Administration Console sign-in");
    await page.goto(consoleUrl, { waitUntil: "domcontentloaded" });
  } catch (e) {
    return { ok: false, error: `could not reach the Mimecast console (${consoleUrl}): ${e?.message ?? e}`, evidence: await shot("nav") };
  }

  const signIn = await signInMimecast({ page, shot, input, log });
  if (!signIn.ok) return signIn;

  if (signInOnly) {
    return { ok: true, message: "signed in to the Mimecast Administration Console" };
  }

  // Phase 2: create the API 2.0 application and harvest its Client ID + Client Secret.
  const appName = input?.params?.appName || "iam-engine";
  return createApiApp({ page, shot, input, log, appName });
}

// -------------------------------------------------------------------------------------------------
// PHASE 2 — CREATE THE API 2.0 APPLICATION + HARVEST (LIVE-VALIDATION PENDING)
// -------------------------------------------------------------------------------------------------
// Drives, post-sign-in: Services/Integrations -> API and Platform Integrations -> Add API Application
// -> name + role (Basic Administrator) + products (Account Management, Domain Management, User & Group
// Management) -> save/activate -> open the app -> Manage API 2.0 credentials -> Generate -> read the
// shown-once Client ID + Client Secret. Idempotent-ish: if an app of this name already exists, it opens
// it and regenerates the 2.0 credential rather than erroring.
//
// EVERY selector here is BEST-EFFORT — the console DOM is unverified (no live tenant / Chromium in this
// env). Each is a small union in this file's style, tagged with its console location, and every step
// logs which stage it reached so a live run pinpoints the first wrong selector. The harvested secret is
// NEVER logged.
const A = {
  // Left-nav / menu route to the API applications list. Mimecast has shipped this under both
  // "Services > API and Platform Integrations" and "Administration > ...". Try a direct link first.
  apiIntegrationsLink: 'a:has-text("API and Platform Integrations"), a:has-text("API Applications"), a[href*="api-applications" i], a[href*="integrations" i]',
  servicesMenu: 'button:has-text("Services"), a:has-text("Services"), button:has-text("Administration"), [role="button"]:has-text("Services")',
  addApp: 'button:has-text("Add API Application"), button:has-text("Add Application"), a:has-text("Add API Application"), button:has-text("Create Application")',
  // Existing app row by name (idempotency).
  appRow: (name) => `tr:has-text("${name}"), [role="row"]:has-text("${name}"), a:has-text("${name}")`,
  appName: 'input[name*="name" i], input[id*="name" i], input[placeholder*="name" i]',
  next: 'button:has-text("Next"), button:has-text("Continue"), button[type="submit"]',
  save: 'button:has-text("Save and Exit"), button:has-text("Save"), button:has-text("Add"), button:has-text("Create"), button[type="submit"]',
  role: 'select[name*="role" i], [aria-label*="role" i], button:has-text("Basic Administrator")',
  product: (label) => `label:has-text("${label}"), text="${label}"`,
  manageCreds: 'button:has-text("Manage API 2.0 credentials"), a:has-text("Manage API 2.0 credentials"), button:has-text("API 2.0"), a:has-text("API 2.0")',
  generate: 'button:has-text("Generate"), button:has-text("Create Keys"), button:has-text("Generate Keys")',
  // The shown-once credential fields. Read from labelled read-only inputs, else nearby monospace text.
  clientId: 'input[readonly][value], [data-testid*="client-id" i], [aria-label*="Client ID" i]',
  clientSecret: 'input[readonly][value], [data-testid*="client-secret" i], [aria-label*="Client Secret" i]',
};

const PRODUCTS = ["Account Management", "Domain Management", "User & Group Management"];

async function createApiApp({ page, shot, input, log, appName }) {
  try {
    // 1. Reach the API applications list. Prefer a direct link; fall back to a Services/Admin menu.
    log("opening API and Platform Integrations");
    let link = page.locator(A.apiIntegrationsLink).first();
    if (!(await link.isVisible().catch(() => false))) {
      await page.locator(A.servicesMenu).first().click().catch(() => {});
      await page.waitForTimeout(1000);
      link = page.locator(A.apiIntegrationsLink).first();
    }
    if (!(await link.isVisible().catch(() => false))) {
      return { ok: false, error: "could not find 'API and Platform Integrations' in the console — VERIFY the navigation selectors against the live Mimecast console.", evidence: await shot("mc-no-integrations") };
    }
    await link.click().catch(() => {});
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(1500);

    // 2. Idempotency: reuse an existing app of this name if present; else Add API Application.
    const existing = page.locator(A.appRow(appName)).first();
    if (await existing.isVisible().catch(() => false)) {
      log(`an API application named "${appName}" already exists — opening it to (re)generate its 2.0 credential`);
      await existing.click().catch(() => {});
      await page.waitForTimeout(1500);
    } else {
      log(`creating API application "${appName}"`);
      const add = page.locator(A.addApp).first();
      if (!(await add.isVisible().catch(() => false))) {
        return { ok: false, error: "could not find the 'Add API Application' button — VERIFY the selector against the live console.", evidence: await shot("mc-no-add") };
      }
      await add.click().catch(() => {});
      await page.waitForTimeout(1000);
      // Name.
      const nameField = page.locator(A.appName).first();
      if (await nameField.isVisible().catch(() => false)) await nameField.fill(appName);
      await page.locator(A.next).first().click().catch(() => {});
      await page.waitForTimeout(1000);

      // Role: Basic Administrator (the wizard step varies — best-effort).
      log("setting role to Basic Administrator");
      const roleSel = page.locator(A.role).first();
      if (await roleSel.isVisible().catch(() => false)) {
        await roleSel.selectOption({ label: "Basic Administrator" }).catch(async () => { await roleSel.click().catch(() => {}); });
      }
      // Products: enable the three required.
      for (const p of PRODUCTS) {
        log(`enabling product: ${p}`);
        const prod = page.locator(A.product(p)).first();
        if (await prod.isVisible().catch(() => false)) await prod.click().catch(() => {});
      }
      // Save / create the application.
      await page.locator(A.save).first().click().catch(() => {});
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(2000);
      // Open the freshly-created app (list may re-render with it selected, or we re-open by name).
      const created = page.locator(A.appRow(appName)).first();
      if (await created.isVisible().catch(() => false)) { await created.click().catch(() => {}); await page.waitForTimeout(1500); }
    }

    // 3. Manage API 2.0 credentials -> Generate.
    log("generating the API 2.0 credential");
    const manage = page.locator(A.manageCreds).first();
    if (await manage.isVisible().catch(() => false)) { await manage.click().catch(() => {}); await page.waitForTimeout(1200); }
    const gen = page.locator(A.generate).first();
    if (!(await gen.isVisible().catch(() => false))) {
      return { ok: false, error: "could not find 'Manage API 2.0 credentials' / 'Generate' — VERIFY the selectors against the live console (the app may need a few minutes to activate before credentials can be generated).", evidence: await shot("mc-no-generate") };
    }
    await gen.click().catch(() => {});
    await page.waitForTimeout(2500);

    // 4. Harvest the shown-once Client ID + Client Secret. Read read-only inputs' values, never log them.
    const harvested = await harvestCredential(page);
    if (!harvested.clientId || !harvested.clientSecret) {
      return { ok: false, error: "the API 2.0 credential was generated but the Client ID / Client Secret could not be read from the page — VERIFY the credential-field selectors against the live console (and that products/role were accepted).", evidence: await shot("mc-no-harvest") };
    }
    log("API 2.0 credential generated and harvested"); // values NEVER logged
    return { ok: true, message: `created/updated the API application "${appName}" and harvested its API 2.0 credential`, harvested };
  } catch (e) {
    return { ok: false, error: `Mimecast API-app creation failed: ${e?.message ?? e}`, evidence: await shot("mc-createapp-error") };
  }
}

// Read the two shown-once credential values off the page. Best-effort: prefer read-only inputs whose
// nearby label mentions ID vs Secret; fall back to the first two read-only value inputs (ID then
// Secret, the console's render order). Never logs the values.
async function harvestCredential(page) {
  const readVal = async (loc) => {
    const el = page.locator(loc).first();
    if (!(await el.count().catch(() => 0))) return "";
    return (await el.inputValue().catch(() => "")) || (await el.getAttribute("value").catch(() => "")) || (await el.innerText().catch(() => "")) || "";
  };
  // Try labelled fields first.
  let clientId = (await readVal('input[readonly][aria-label*="Client ID" i], input[readonly][id*="client-id" i], input[readonly][name*="clientid" i]')).trim();
  let clientSecret = (await readVal('input[readonly][aria-label*="Client Secret" i], input[readonly][id*="client-secret" i], input[readonly][name*="secret" i]')).trim();
  if (!clientId || !clientSecret) {
    // Fallback: the two read-only value inputs on the credential panel, in render order (ID, Secret).
    const ro = page.locator('input[readonly]');
    const n = await ro.count().catch(() => 0);
    const vals = [];
    for (let i = 0; i < n && vals.length < 2; i++) {
      const v = (await ro.nth(i).inputValue().catch(() => "")).trim();
      if (v) vals.push(v);
    }
    if (!clientId && vals[0]) clientId = vals[0];
    if (!clientSecret && vals[1]) clientSecret = vals[1];
  }
  return { clientId, clientSecret };
}
