// Flow: google-oauth-signin
// ---------------------------------------------------------------------------------------------
// Sign in to Google as the Workspace super-admin and complete an OAuth consent, capturing the
// authorization code Google redirects back with. The auth URL (with its PKCE challenge already
// embedded) and the loopback redirect URI are handed to us by the app; we drive Google's own
// sign-in sequence — email -> Next -> password -> Next -> TOTP (when challenged) -> consent
// "Allow"/"Continue" — and then intercept the redirect to the loopback URI WITHOUT serving it, so no
// local listener is needed: a page.route on the redirect pattern fulfills a tiny "you may close this
// window" body while we read `code` off the intercepted request URL (fallback: parse the failed
// navigation's page.url()). The code is the flow's OUTPUT and rides ONLY the result line
// (OAUTH_CODE:<code>) — never a log or WARN line.
//
// HIDDEN-ELEMENT DISCIPLINE (PR #101 lesson, ported from the MS login): Google's sign-in is a
// single-page app that pre-renders later views, so isVisible() lies — a field can report "visible"
// while its step isn't on screen. We assert onActiveView (a real, non-aria-hidden, full-width input)
// before typing anything, and we detect the "typed the password, no navigation, no error" stall
// instead of waiting out a timeout and blaming the credentials.
//
// LIVE-VALIDATION PENDING: this flow cannot be exercised with Playwright in this environment (no
// Chromium). The pure helpers below (redirect parsing + the result line) are unit-tested; the browser
// path is validated live in Task 12. Selectors follow Google's documented/stable field names
// (identifierId / Passwd / totpPin) in the resilient-selector style of this directory.
import { onActiveView, waitForCondition } from "../lib/ms-sso-login.mjs";
import { totp } from "../lib/totp.mjs";

// The loopback the app's google-oauth.ts pins as the OAuth redirect. Used only as a default; the job
// config supplies the authoritative value (input.params.redirectUri).
const DEFAULT_REDIRECT_URI = "http://127.0.0.1:8765/oauth2callback";

// Google sign-in field names. `identifier`/`Passwd`/`totpPin` are Google's own stable field names;
// the extra selectors are resilient fallbacks in the style of ms-sso-login.mjs.
const G = {
  email: 'input[type="email"], input#identifierId, input[name="identifier"]',
  password: 'input[type="password"], input[name="Passwd"], input[name="password"]',
  // Google's per-step "Next" lives in a #identifierNext / #passwordNext / #totpNext wrapper.
  next: '#identifierNext button, #passwordNext button, #totpNext button, button:has-text("Next"), button[type="submit"]',
  // The Google Authenticator / TOTP code box.
  totp: 'input[name="totpPin"], input#totpPin, input[autocomplete="one-time-code"], input[type="tel"]',
  totpNext: '#totpNext button, button:has-text("Next"), button:has-text("Verify"), button[type="submit"]',
  // The OAuth consent screen's grant button (internal Workspace apps show Allow/Continue).
  consent: 'button:has-text("Allow"), button:has-text("Continue"), #submit_approve_access button, button[type="submit"]',
  // "Verify it's you" method chooser + the passkey/other-methods interstitial escape hatch.
  tryAnotherWay: 'button:has-text("Try another way"), a:has-text("Try another way"), text=/try another way/i',
  authenticatorOption: 'text=/Google Authenticator|authenticator app|verification code/i',
  // Google's own inline sign-in error (wrong password / couldn't find account / rejected code).
  // ARIA error semantics ONLY. The obfuscated class selectors this used to also carry (.Ekjuhf et al.)
  // matched Google's page HEADING, not just errors — the newer real-browser sign-in layout renders a
  // "Welcome" <h1> in .Ekjuhf on the normal password page, so readGoogleError reported "Welcome" as a
  // rejection and aborted a perfectly good sign-in (only surfaced once the de-headless UA made Google
  // serve that layout; old-headless got a legacy layout without the heading). Genuine sign-in errors
  // are announced via role=alert / aria-live=assertive, which the "Welcome" heading is not.
  error: 'div[role="alert"]:visible, [aria-live="assertive"]:visible',
};

// Page headings/labels that can legitimately sit inside a live region and are NOT sign-in errors — a
// defensive second guard so a future markup shift can't turn a benign heading back into a false
// "Google rejected the sign-in". Matched case-insensitively against the first line of the alert text.
const BENIGN_SIGNIN_TEXT = [/^welcome$/i, /^sign in$/i, /^choose an account$/i, /^verify it.?s you$/i];
export function isBenignSigninText(text) {
  const first = (text ?? "").trim().split("\n")[0].trim();
  if (!first) return true; // empty => nothing to report
  return BENIGN_SIGNIN_TEXT.some((re) => re.test(first));
}

// -------------------------------------------------------------------------------------------------
// PURE HELPERS (unit-tested; no browser) — exported for the test harness and for google-dwd-grant.
// -------------------------------------------------------------------------------------------------

// Parse a Google OAuth callback URL into { code, error, errorDescription }. Tolerant: a non-URL or a
// callback carrying neither param yields nulls rather than throwing. URLSearchParams decodes the
// percent-encoding Google applies to the code's '/'.
export function parseOAuthRedirect(urlStr) {
  try {
    const u = new URL(urlStr);
    const code = u.searchParams.get("code");
    const error = u.searchParams.get("error");
    const errorDescription = u.searchParams.get("error_description");
    return { code: code || null, error: error || null, errorDescription: errorDescription || null };
  } catch {
    return { code: null, error: null, errorDescription: null };
  }
}

// Does `urlStr` point at the loopback redirect (regardless of its query string)? Compared by
// origin+pathname so Google's own auth pages and other paths on the same host don't match. A route
// pattern (redirectUri + "*") does the real interception; this backs the navigation-failure fallback.
export function matchesRedirect(urlStr, redirectUri) {
  try {
    const a = new URL(urlStr);
    const b = new URL(redirectUri);
    return a.origin === b.origin && a.pathname === b.pathname;
  } catch {
    return false;
  }
}

// The flow's result line — the ONLY place the captured code appears. The app reads it back with
// /(^|\n)\s*OAUTH_CODE:(\S+)/, so the code (which contains no whitespace) rides as-is.
export function formatOAuthCodeLine(code) {
  return `OAUTH_CODE:${code}`;
}

// -------------------------------------------------------------------------------------------------
// BROWSER PATH (LIVE-VALIDATION PENDING)
// -------------------------------------------------------------------------------------------------

// Mint a CURRENT one-time password from the app AT THE TOTP BOX (mirrors ms-sso-login's mintOtp: a
// TOTP code lives ~30s and the sign-in hop outlives that, so any code fetched earlier is dead on
// arrival). otpReq = { url, token, agentId, secretName }. Returns the code or null; never logs it.
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

// Blank the TOTP box before any evidence screenshot on a failure path — unlike the password field
// (dots), the code box is plain text and would be legible in the pixels of an attached screenshot.
async function scrubTotp(page) {
  try { await page.locator(G.totp).first().fill(""); } catch { /* gone/navigated */ }
}

// The visible Google sign-in error text, or null. Only when actually shown with text — an empty
// placeholder alert node must not be read as a failure.
async function readGoogleError(page) {
  const box = page.locator(G.error).first();
  if (!(await box.isVisible().catch(() => false))) return null;
  const t = await box.innerText().catch(() => null);
  if (!t || !t.trim()) return null;
  // A live region can briefly carry a benign heading/label — don't mistake it for a rejection.
  if (isBenignSigninText(t)) return null;
  return t.trim().split("\n")[0];
}

// Handle Google's second factor when it challenges for a TOTP code. Returns { done:true } (past it or
// none), or { bail:<structured error> }. A passkey / "Verify it's you" interstitial is escaped via
// "Try another way" -> the authenticator option, then the TOTP box. Push/tap/SMS is a hard stop.
async function handleSecondFactor(page, shot, mfa, log) {
  try {
    // A passkey / method-chooser interstitial can stand between the password and the code box. If a
    // TOTP field isn't up yet but a "Try another way" escape is, take it and pick the authenticator.
    const totpField = page.locator(G.totp).first();
    if (!(await onActiveView(totpField))) {
      const escape = page.locator(G.tryAnotherWay).first();
      if (await escape.isVisible().catch(() => false)) {
        log("passkey/other-method interstitial — choosing 'Try another way' -> authenticator");
        await escape.click().catch(() => {});
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        const opt = page.locator(G.authenticatorOption).first();
        if (await opt.isVisible().catch(() => false)) {
          await opt.click().catch(() => {});
          await page.waitForLoadState("domcontentloaded").catch(() => {});
        }
        await waitForCondition(page, () => onActiveView(totpField), 15_000);
      }
    }

    if (!(await onActiveView(totpField))) return { done: true }; // no code challenge

    // Freshest code first; a retry must submit a DIFFERENT code (within one 30s window Delinea/the
    // seed return the byte-identical code), so wait out the window in short hops until it rolls.
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
        return { bail: { ok: false, error: "Google requires a verification code but none was available — enable One-Time Password on the 'google-super-admin' secret in Delinea (the runner mints a fresh code at the prompt), or complete the sign-in manually.", evidence: await shot("mfa-no-code") } };
      }
      lastCode = next.code;
      log(attempt === 0 ? "entering the verification code" : "code rejected — retrying once with a fresh code"); // never log the code
      await totpField.fill(next.code);
      await page.locator(G.totpNext).first().click().catch(() => {});
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(2500);
      if (!(await page.locator(G.totp).first().isVisible().catch(() => false))) return { done: true }; // accepted
    }
    await scrubTotp(page);
    return { bail: { ok: false, error: "the Google verification code was rejected — re-pair the authenticator into the secret's One-Time Password in Delinea, and confirm the account uses an authenticator app (not a push/SMS prompt).", evidence: await shot("totp-rejected") } };
  } catch (e) {
    await scrubTotp(page);
    return { bail: { ok: false, error: `second-factor handling failed: ${e?.message ?? e}`, evidence: await shot("mfa-error") } };
  }
}

// Drive Google's sign-in pages: email -> Next -> password -> Next -> (second factor). Returns
// { ok:true } or { ok:false, error, evidence }. Assumes the page is already on (or navigating to) an
// accounts.google.com sign-in view — the caller owns getting there and owns its own post-sign-in
// success condition (a consent redirect for OAuth, the Admin console for DWD). Exported so
// google-dwd-grant can reuse the exact same sign-in.
export async function signInGoogle({ page, shot, input, log }) {
  const username = input?.username ?? null;
  const password = input?.password ?? null; // NEVER logged
  const mfa = {
    otpReq: input?.params?.otp ?? null,
    otpCode: input?.params?.otpCode ?? null,
    totpSeed: input?.params?.totpSeed ?? input?.totpSeed ?? null,
  };
  if (!username || !password) {
    return { ok: false, error: "no Google sign-in credentials brokered (username/password) — wire the 'google-super-admin' secret with a super-admin email + password." };
  }

  try {
    // 1. Email step. Assert the field is on the ACTIVE view (not a pre-rendered ghost) before typing.
    const emailField = page.locator(G.email).first();
    if (await waitForCondition(page, () => onActiveView(emailField), 20_000)) {
      log("entering the Google sign-in email");
      await emailField.fill(username);
      await page.locator(G.next).first().click().catch(() => {});
      await page.waitForLoadState("domcontentloaded").catch(() => {});
    }

    // 2. Password step. Wait for the real password view — Google looks the account up first.
    const pwField = page.locator(G.password).first();
    const gotPw = await waitForCondition(page, async () => (await onActiveView(pwField)) || (await readGoogleError(page)) != null, 20_000);
    const earlyErr = await readGoogleError(page);
    if (earlyErr) return { ok: false, error: `Google rejected the sign-in: ${earlyErr}`, evidence: await shot("google-email-error") };
    if (!gotPw || !(await onActiveView(pwField))) {
      // No password box and no error — maybe a passwordless/second-factor-first prompt.
      const sf = await handleSecondFactor(page, shot, mfa, log);
      if (sf.bail) return sf.bail;
      return { ok: false, error: "could not reach the Google password field — VERIFY the sign-in selectors against the live console.", evidence: await shot("no-password-field") };
    }
    log("entering the Google sign-in password"); // the VALUE is never logged
    await pwField.fill(password);
    await page.locator(G.next).first().click().catch(() => {});
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(2000);

    // The MS-login lesson: a rejected password re-renders with an error; an untouched, still-active
    // password box means the submit never took. Read the error BEFORE deciding it stalled.
    const pwErr = await readGoogleError(page);
    if (pwErr) return { ok: false, error: `Google rejected the sign-in: ${pwErr}`, evidence: await shot("google-password-error") };
    if (await onActiveView(pwField)) {
      return { ok: false, error: "the password was entered but Google's sign-in did not advance and showed no error — VERIFY the sign-in selectors / that the account isn't blocked.", evidence: await shot("password-no-advance") };
    }

    // 3. Second factor (the common case, after the password).
    const sf = await handleSecondFactor(page, shot, mfa, log);
    if (sf.bail) return sf.bail;

    const lateErr = await readGoogleError(page);
    if (lateErr) return { ok: false, error: `Google rejected the sign-in: ${lateErr}`, evidence: await shot("google-signin-error") };
  } catch (e) {
    return { ok: false, error: `Google sign-in failed: ${e?.message ?? e}`, evidence: await shot("login-error") };
  }
  return { ok: true };
}

// -------------------------------------------------------------------------------------------------
// FLOW ENTRY
// -------------------------------------------------------------------------------------------------
export default async function googleOAuthSignin({ page, shot, input, log }) {
  const authUrl = input?.params?.authUrl ?? null;
  const redirectUri = input?.params?.redirectUri ?? DEFAULT_REDIRECT_URI;
  if (!authUrl) {
    return { ok: false, error: "no OAuth auth URL was provided (params.authUrl) — the app must supply the consent URL (PKCE challenge embedded)." };
  }

  // Capture the redirect WITHOUT serving it. Two mechanisms, because Chromium exposes the loopback
  // hop differently depending on how it's reached:
  //   - request/requestfailed listeners (PRIMARY): Google's consent response is a server-side 302,
  //     and Playwright routing does NOT get a shot at redirect hops of an in-flight navigation — the
  //     browser follows the redirect at the network layer, the connection to 127.0.0.1:8765 is
  //     refused (nothing listens there, by design), and the page lands on chrome-error://chromewebdata/
  //     (also why page.url() is useless afterwards). The Request object still carries the full
  //     redirect URL, code included — read it there. Proven against the live console (first Drive
  //     Capital run: the code rode a requestfailed event, never the route).
  //   - page.route fulfill (SECONDARY): covers a client-side navigation to the callback, where
  //     interception does work — fulfil a tiny page so the browser doesn't error.
  let captured = null;
  const maybeCapture = (url) => {
    if (!captured && matchesRedirect(url, redirectUri)) captured = parseOAuthRedirect(url);
  };
  page.on("request", (r) => maybeCapture(r.url()));
  page.on("requestfailed", (r) => maybeCapture(r.url()));
  try {
    // Match on origin+pathname via a predicate (not a glob): the callback query carries '/' — an
    // encoded code and the scope URLs — which Playwright's glob '*' would not span, so a glob could
    // miss the redirect entirely. matchesRedirect ignores the query, which is exactly right here.
    await page.route((u) => matchesRedirect(u.toString(), redirectUri), async (route) => {
      maybeCapture(route.request().url());
      try {
        await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><meta charset=utf-8><body>You may close this window.</body>" });
      } catch { try { await route.abort(); } catch { /* already handled */ } }
    });
  } catch (e) {
    return { ok: false, error: `could not set up the redirect capture: ${e?.message ?? e}` };
  }

  // 1. Navigate to the consent URL.
  try {
    log("navigating to the Google OAuth consent URL");
    await page.goto(authUrl, { waitUntil: "domcontentloaded" });
  } catch (e) {
    return { ok: false, error: `could not reach the Google OAuth consent URL: ${e?.message ?? e}`, evidence: await shot("nav") };
  }

  // 2. Sign in (email/password/second factor). The redirect could already have fired for an app that
  //    was previously consented (Google skips the consent screen) — so only bail on a sign-in error
  //    if nothing was captured in the meantime.
  const signIn = await signInGoogle({ page, shot, input, log });
  if (!signIn.ok && !captured?.code) return signIn;

  // 3. Consent — click Allow/Continue until Google redirects to the loopback (route captures it) or a
  //    definite OAuth error comes back. Already-consented apps skip straight to the redirect.
  try {
    const settled = await waitForCondition(page, async () => {
      if (captured) return true;
      if (matchesRedirect(page.url(), redirectUri)) return true; // navigation-failure fallback
      const consentBtn = page.locator(G.consent).first();
      if (await consentBtn.isVisible().catch(() => false)) {
        log("granting consent");
        await consentBtn.click().catch(() => {});
        await page.waitForLoadState("domcontentloaded").catch(() => {});
      }
      return false;
    }, 45_000);

    // Fallback: the loopback navigation may have failed (connection refused) and parked the URL on the
    // redirect with the code in the query — read it off page.url() if the route didn't fire.
    if (!captured && matchesRedirect(page.url(), redirectUri)) {
      captured = parseOAuthRedirect(page.url());
    }

    if (!captured) {
      return { ok: false, error: settled ? "reached the redirect but captured no OAuth result" : "the OAuth sign-in did not reach the redirect (timed out at consent / an unexpected challenge page) — VERIFY the flow against the live console.", evidence: await shot("no-redirect") };
    }
    if (captured.error) {
      return { ok: false, error: `Google returned an OAuth error: ${captured.error}${captured.errorDescription ? ` (${captured.errorDescription})` : ""}`, evidence: await shot("oauth-error") };
    }
    if (!captured.code) {
      return { ok: false, error: "the OAuth redirect carried no authorization code.", evidence: await shot("no-code") };
    }
    // Success — the code rides ONLY this result line (message), never a log/WARN/screenshot.
    return { ok: true, message: formatOAuthCodeLine(captured.code) };
  } catch (e) {
    return { ok: false, error: `could not complete the OAuth consent: ${e?.message ?? e}`, evidence: await shot("consent-error") };
  }
}
