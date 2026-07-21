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

  // Phase 2 (create the API 2.0 application + harvest the credential) is not built yet. Reaching here
  // means a caller dispatched a full run against a Phase-1 runner — fail clearly rather than silently
  // no-op so it's obvious the automated setup isn't available on this agent.
  return { ok: false, error: "automated Mimecast API-app creation is not implemented in this runner version — use the guided setup's Paste fields tab to enter the credential." };
}
