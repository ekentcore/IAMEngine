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
const DEFAULT_PORTAL_URL = "https://o365.spanningbackup.com/login.html";
// Read at CALL time, not module-load time: a module-level const captures whatever the environment held
// when the file was first imported, which makes the URL impossible to override per-run (and silently
// sent a test harness at the real production portal). Regional consoles (o365-us / o365-eu …) are set
// through this same variable.
const portalUrl = () => process.env.SPANNING_PORTAL_URL || DEFAULT_PORTAL_URL;

// The origin we must be on before firing the console's own authenticated API call.
//
// The trust anchor is a CONSTANT, deliberately not derived from SPANNING_PORTAL_URL: deriving it from
// the value being validated means the check can never reject a misconfigured — or hostile — portal
// URL, and this gate is what stops an authenticated, same-origin, credentialed POST being sent to
// somewhere it shouldn't. Regional consoles (o365-us / o365-eu …) are all under this domain, so a
// legitimate override still passes.
//
// Matching is on the registrable domain with an explicit label boundary, so neither
// "evilspanningbackup.com" (suffix confusion) nor "spanningbackup.com.evil.com" (prefix confusion)
// can pass.
const TRUSTED_PORTAL_DOMAIN = "spanningbackup.com";

// Test harnesses serve a stand-in console on localhost. That is an explicit, opt-in escape hatch —
// never something a misconfigured env var can trip into by accident.
const allowUntrustedOrigin = () => process.env.SPANNING_ALLOW_ANY_ORIGIN === "1";

const onPortalOrigin = (href) => {
  try {
    const h = new URL(href).hostname.toLowerCase();
    if (allowUntrustedOrigin()) return true;
    return h === TRUSTED_PORTAL_DOMAIN || h.endsWith(`.${TRUSTED_PORTAL_DOMAIN}`);
  } catch { return false; }
};

// The sync is asynchronous: /api/sync returns a job id with status PENDING and the console polls
// /api/tenantCache/{id} (both confirmed from the captured HAR). A still-PENDING job is reported as
// "started" with a recheck window, not as a failure.
const SYNC_IS_ASYNC = true;
const RETRY_AFTER_MINUTES = 10;

import { totp } from "../lib/totp.mjs";

// There are no post-login "sync-control" SELECTORS to verify any more: the sync is fired by replaying
// the console's own /api/sync call (below), which is what the button does. The login path is confirmed
// against o365.spanningbackup.com/login.html → Microsoft 365 SSO.
// How long we'll watch the sync job before handing back to the app's own retry (it's async).
//
// The captured HAR of a real console sync shows the job still PENDING after 2+ minutes, so the old
// 45s window could never observe a completion. But the poll CANNOT simply be widened to match: this
// flow runs as a child process that Invoke-CtgBrowserFlow KILLS at -TimeoutSeconds, and a killed
// process never prints its JSON line — so a sync that actually fired would be reported to the
// operator as a failed one, losing retryAfterMinutes and the re-check with it. That is strictly worse
// than a short poll.
//
// INVARIANT: (browser launch + SSO + MFA + KMSI + redirect) + pollMs() must stay comfortably under
// the -TimeoutSeconds that Coretelligent.Spanning passes to Invoke-CtgBrowserFlow (currently 420s,
// raised from the 180s default for exactly this reason). Keep these two in step.
const pollMs = () => Number(process.env.SPANNING_POLL_MS) || 120_000;

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

// Mint a CURRENT one-time password from the app AT THE MFA BOX — not before the browser launched.
// A TOTP code lives ~30s; browser start + portal load + the SSO hop routinely take longer than
// that, so any code fetched before page-load is dead on arrival. otpReq = { url, token, agentId,
// secretName } (the job credential endpoint the runner already uses). Returns the code or null;
// the code itself is NEVER logged.
// Blank the one-time-code box before any evidence screenshot on a failure path. Unlike a password
// field (rendered as dots), the MFA input is a plain text/tel box — the Delinea-minted code is
// legible in the screenshot pixels, and evidence is attached to the case and kept. Best-effort.
async function scrubOtpField(page) {
  try { await page.locator(SELECTORS.otpInput).first().fill(""); } catch { /* field gone/navigated — nothing to scrub */ }
}

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

// Handle a possible second factor after the password step. Returns { done:true } when past MFA (or
// there is none), or { bail:<structured error> } when we can't proceed. Code sources, best first:
// mint from Delinea AT this moment (mfa.otpReq), a pre-minted code (mfa.otpCode, legacy runner), a
// stored seed (mfa.totpSeed, legacy secret). Push/number-matching/SMS is a hard stop (no device).
async function handleSecondFactor(page, shot, mfa, log) {
  try {
    // Unautomatable factors first — a push/number/SMS prompt can't be satisfied headless.
    if (await page.locator(SELECTORS.pushChallenge).first().isVisible().catch(() => false)) {
      return { bail: { ok: false, error: "the login requires push / number-matching / SMS MFA — a headless bot can't approve that. Switch the automation account to app (authenticator) MFA and enable One-Time Password on its Delinea secret, or trigger the Spanning sync manually.", evidence: await shot("mfa-push") } };
    }
    const otp = page.locator(SELECTORS.otpInput).first();
    const hasOtp = await otp.isVisible().catch(() => false);
    const textChallenge = await page.locator(SELECTORS.mfaChallenge).first().isVisible().catch(() => false);
    if (!hasOtp && !textChallenge) return { done: true }; // no second factor
    if (!hasOtp) {
      return { bail: { ok: false, error: "an MFA challenge appeared but no code-entry field was found — if it's a push/number prompt it can't be automated; if it's a code prompt, VERIFY the otpInput selector against the real console.", evidence: await shot("mfa-no-code-field") } };
    }

    // Next code to try, freshest source first. The pre-minted code is single-use for retry purposes
    // (if it was stale once it stays stale); minting and the seed can produce a new code each try.
    // A RETRY must submit a DIFFERENT code: within one 30s TOTP window Delinea (and a local seed)
    // return the byte-identical code that was just rejected, so wait out the window — up to ~30s in
    // 8s hops — until the produced code actually changes.
    let preMintedUsed = false;
    const produce = async () => {
      if (mfa.otpReq) { const c = await mintOtp(mfa.otpReq, log); if (c) return { code: c, source: "delinea" }; }
      if (mfa.otpCode && !preMintedUsed) { preMintedUsed = true; return { code: String(mfa.otpCode), source: "delinea" }; }
      if (mfa.totpSeed) {
        try { return { code: totp(mfa.totpSeed), source: "seed" }; }
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
      if (next?.code && rejected && next.code === rejected) return null; // window never rolled — nothing new to try
      return next;
    };

    // One retry: a code can legitimately die between mint and submit (window rollover) — get a
    // fresh one and try again before declaring the MFA setup broken.
    let lastSource = null;
    let lastCode = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const next = await nextCode(lastCode);
      if (next?.err) return { bail: { ok: false, error: next.err, evidence: await shot("totp-error") } };
      if (!next) {
        if (attempt > 0) break; // had a code, it was rejected, and no source can mint another
        return { bail: { ok: false, error: "the login requires MFA but no code was available — enable One-Time Password on the Spanning secret in Delinea (paste the authenticator seed there once); the runner then fetches a fresh code at the MFA prompt. Or trigger the sync manually.", evidence: await shot("mfa-no-code") } };
      }
      lastSource = next.source;
      lastCode = next.code;
      log(attempt === 0 ? "entering the one-time code" : "code rejected — retrying once with a fresh code"); // the code is never logged
      await otp.fill(next.code);
      await page.locator(SELECTORS.otpSubmit).first().click().catch(() => {});
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(3500);
      // No longer on a code field ⇒ accepted.
      if (!(await page.locator(SELECTORS.otpInput).first().isVisible().catch(() => false))) return { done: true };
    }
    const hint = lastSource === "seed"
      ? "check the seed on the Spanning secret and that the automation account uses app/TOTP MFA (not push/SMS)"
      : "the account's MFA may not be the authenticator this Delinea secret holds (re-pair the authenticator into the secret's One-Time Password)";
    await scrubOtpField(page);
    return { bail: { ok: false, error: `the one-time code was rejected — ${hint}.`, evidence: await shot("otp-rejected") } };
  } catch (e) {
    await scrubOtpField(page);
    return { bail: { ok: false, error: `second-factor handling failed: ${e?.message ?? e}`, evidence: await shot("mfa-error") } };
  }
}

export default async function spanningForceSync({ page, shot, input, log }) {
  const email = input?.params?.email ?? null;
  const username = input?.username ?? null;
  const password = input?.password ?? null; // NEVER logged
  // MFA code sources (all values NEVER logged). otp = { url, token, agentId, secretName }: the app
  // endpoint to mint a fresh Delinea code AT the MFA prompt — preferred, because a TOTP code lives
  // ~30s and anything fetched before the browser launched is stale by the time login reaches MFA.
  const mfaSources = {
    otpReq: input?.params?.otp ?? null,
    otpCode: input?.params?.otpCode ?? null, // pre-minted code (legacy runner) — likely stale, kept as fallback
    totpSeed: input?.params?.totpSeed ?? input?.totpSeed ?? null, // legacy stored seed
  };

  if (!username || !password) {
    return { ok: false, error: "no Spanning portal credentials brokered (username/password) — set them on the client's Spanning secret" };
  }

  // 1. Navigate to the console, then pick "Log In with Microsoft" to hand off to Microsoft 365 SSO.
  try {
    const url = portalUrl();
    log(`navigating to the Spanning admin console (${url})`);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const msBtn = page.locator(SELECTORS.microsoftLogin).first();
    if (await msBtn.isVisible().catch(() => false)) {
      log('selecting "Log In with Microsoft"');
      await msBtn.click().catch(() => {});
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(2000);
    }
  } catch (e) {
    return { ok: false, error: `could not reach the Spanning console (${portalUrl()}): ${e?.message ?? e}`, evidence: await shot("nav") };
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
      const mfa = await handleSecondFactor(page, shot, mfaSources, log);
      if (mfa.bail) return mfa.bail;
      return { ok: false, error: "could not find the password field on the Spanning login page — VERIFY the portal URL and selectors against the real console", evidence: await shot("no-password-field") };
    }
    log("entering the portal password"); // the VALUE is never logged
    await pwField.fill(password);
    await page.locator(SELECTORS.submit).first().click();
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(2000);

    // Second factor after the password (the common case) — mint/complete a code or bail clearly.
    const mfa = await handleSecondFactor(page, shot, mfaSources, log);
    if (mfa.bail) return mfa.bail;

    // A surfaced Microsoft error (bad password, locked account, blocked by Conditional Access) is far
    // more useful to an operator than "still on the login page".
    //
    // This MUST run BEFORE the KMSI click below. Microsoft re-renders the sign-in form on its error
    // page, so clicking first would re-submit the password — burning a second failed attempt against
    // the admin account (halving the Entra smart-lockout runway, the very risk this change exists to
    // remove) and navigating away before the error could be read.
    //
    // Only Microsoft's OWN error ids, and only when actually visible with text: generic selectors like
    // `.alert-error` match empty placeholder nodes and would turn a benign banner into a hard failure.
    const errBox = page.locator("#passwordError, #usernameError, #idSpan_SAOTCC_Error_OTC, #service_exception_message").first();
    const msError = (await errBox.isVisible().catch(() => false))
      ? await errBox.innerText().catch(() => null)
      : null;
    if (msError && msError.trim()) {
      return { ok: false, error: `Microsoft rejected the sign-in: ${msError.trim().split("\n")[0]}`, evidence: await shot("ms-signin-error") };
    }

    // Microsoft's "Stay signed in?" (KMSI) interstitial sits BETWEEN a successful MFA and the redirect
    // back to the app. Left unanswered, the browser parks on login.microsoftonline.com and the sync
    // below bails with "wrong-origin" — i.e. a fully successful sign-in reported as a failure.
    //
    // Identify it by the PAGE, not by a button id: #idSIButton9 is Microsoft's GENERIC submit id (it's
    // "Next" on the username page, "Sign in" on the password page, "Yes" here), and a bare
    // `button:has-text("Yes")` would happily match something else entirely — including the console's
    // own buttons once we're back on it. We require the KMSI form itself to be present, then click its
    // button. Either answer is fine; "Yes" also persists device trust for the profile.
    const kmsiForm = page.locator('form[name="hiddenform"], #kmsiForm, :has-text("Stay signed in?")');
    const kmsiBtn = page.locator('#idSIButton9:visible, #idBtn_Back:visible').first();
    const onKmsi =
      (await page.locator('input[name="DontShowAgain"], #KmsiCheckboxField').count().catch(() => 0)) > 0 ||
      (await kmsiForm.filter({ hasText: /stay signed in\?/i }).count().catch(() => 0)) > 0;
    if (onKmsi && (await kmsiBtn.isVisible().catch(() => false))) {
      log('answering Microsoft\'s "Stay signed in?" prompt');
      await kmsiBtn.click().catch(() => {});
      await page.waitForLoadState("domcontentloaded").catch(() => {});
    }

    // Wait for the redirect BACK to the Spanning console rather than guessing with a fixed sleep — the
    // hand-off through Microsoft SSO takes as long as it takes, and a short sleep is what made this
    // read as "wrong origin" before.
    await page.waitForURL((u) => onPortalOrigin(String(u)), { timeout: 60_000 }).catch(() => {});

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
    if (!onPortalOrigin(origin)) {
      return { ok: false, error: `after login the page is on ${origin}, not a Spanning console origin — cannot fire the sync from here`, evidence: await shot("wrong-origin") };
    }

    // CONNECTION TEST (signInOnly): everything above — Microsoft SSO, the password, the Delinea-minted
    // MFA code, the "Stay signed in?" interstitial, and the origin gate — has now passed, which is the
    // entire question the test asks. Stop here and change nothing: a test must not fire a real sync.
    // It runs this same flow rather than a bespoke copy precisely so that what it proves is what the
    // force-sync will actually do.
    if (input?.params?.signInOnly) {
      log(`signed in to the Spanning console at ${origin} (sign-in check only — no sync triggered)`);
      return { ok: true, message: `signed in to the Spanning console at ${origin}` };
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
      const deadline = Date.now() + pollMs();
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
