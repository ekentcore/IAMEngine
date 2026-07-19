// Shared lib: Microsoft 365 / Entra SSO sign-in (username -> password -> MFA -> error gate -> KMSI).
// ---------------------------------------------------------------------------------------------
// This is a FAITHFUL COPY of the proven MS-SSO login machinery that lives inline in
// runner/browser/flows/spanning-force-sync.mjs (verified against the live console 2026-07-12 /
// 2026-07-16, incl. a HAR capture). That file is live-validated production code and is
// deliberately NOT modified or imported from here — this lib is written fresh by reproducing its
// logic exactly, so any flow that needs to sit through Microsoft's own SSO pages (spanning's
// "Log In with Microsoft" hand-off, an Entra device-code prompt, or anything else that lands on
// login.microsoftonline.com) can reuse it.
//
// ACCEPTED TRADEOFF: this duplication (rather than spanning-force-sync.mjs importing from here) is
// a DELIBERATE decision, not an oversight — spanning is live-validated production code that cannot
// be Playwright-tested in this environment, so it was not refactored blind. Converging
// spanning-force-sync.mjs onto this shared lib is a deliberate follow-up to be done WITH live
// browser validation against the real console, not blind. Do not "clean up" the duplication without
// that live validation.
//
// Exported: signInMicrosoft({ page, shot, input, log }) -> { ok:true } |
// { ok:false, error, evidence }. Also exports SELECTORS/onActiveView/waitForCondition for callers
// that need to poll their OWN pre/post-login pages the same aria-hidden-safe way (or share the field
// selectors, e.g. to detect the real sign-in page has been reached before handing off).

import { totp } from "./totp.mjs";

// Microsoft 365 sign-in fields (loginfmt/passwd are the stable MS field names) + MFA selectors.
// Copied verbatim from spanning-force-sync.mjs SELECTORS (the login/MFA subset — the Spanning
// console's own "Log In with Microsoft" chooser button is NOT part of this shared lib; callers
// land on the MS pages however they get there).
export const SELECTORS = {
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

// Is this field on the view the user is actually looking at?
//
// Microsoft's sign-in is a SINGLE-PAGE app: the username and password views are BOTH pre-rendered into
// the same document, and the INACTIVE one is parked in an `aria-hidden="true"` container with its
// inputs collapsed to a ~10x13 box. Playwright's isVisible() only asks for a non-empty box and no
// visibility:hidden — a 10x13 box satisfies both — so the password field reports VISIBLE while the
// username step is still on screen. (Verified against the live login.microsoftonline.com on
// 2026-07-16: on the username view #i0118 is 10x13 inside aria-hidden and #idSIButton9 reads "Next";
// after Next they swap — #i0118 becomes 348x36 and outside aria-hidden, the button becomes "Sign in".)
//
// Trusting isVisible() here is what broke the real console login (UM0029840): the flow decided the
// password box was already up, SKIPPED the "Next" click, typed the password into the offscreen field,
// then spent its ONE submit click on "Next" — arriving at the password view with the password
// pre-filled but never submitted. No MFA prompt ever appeared (so the Delinea one-time password path
// never ran), and 60s later it blamed the credentials with "still on the login page".
//
// Both signals are Microsoft's own and they flip together, so we require both: outside any aria-hidden
// subtree, and a box wide enough to be a real input rather than the collapsed placeholder. Width alone
// separates them cleanly (10px vs 348px); height does not (13px vs 36px is too close to a default
// input's ~21px to be a safe discriminator).
export async function onActiveView(locator) {
  if (!(await locator.isVisible().catch(() => false))) return false;
  return await locator
    .evaluate((el) => !el.closest('[aria-hidden="true"]') && el.getBoundingClientRect().width > 40)
    .catch(() => false);
}

// Poll a condition instead of sleeping a fixed guess. Microsoft looks the account up before it will
// render the password box, so the username step takes as long as it takes; a fixed sleep that expires
// early lands back in the same "the field is there but not really" trap onActiveView exists to close.
export async function waitForCondition(page, cond, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(250);
  }
}

// Mint a CURRENT one-time password from the app AT THE MFA BOX — not before the browser launched.
// A TOTP code lives ~30s; browser start + page load + the SSO hop routinely take longer than
// that, so any code fetched before page-load is dead on arrival. otpReq = { url, token, agentId,
// secretName } (the job credential endpoint the runner already uses). Returns the code or null;
// the code itself is NEVER logged.
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

// Blank the one-time-code box before any evidence screenshot on a failure path. Unlike a password
// field (rendered as dots), the MFA input is a plain text/tel box — the Delinea-minted code is
// legible in the screenshot pixels, and evidence is attached to the case and kept. Best-effort.
export async function scrubOtpField(page) {
  try { await page.locator(SELECTORS.otpInput).first().fill(""); } catch { /* field gone/navigated — nothing to scrub */ }
}

// Handle a possible second factor after the password step. Returns { done:true } when past MFA (or
// there is none), or { bail:<structured error> } when we can't proceed. Code sources, best first:
// mint from Delinea AT this moment (mfa.otpReq), a pre-minted code (mfa.otpCode, legacy runner), a
// stored seed (mfa.totpSeed, legacy secret). Push/number-matching/SMS is a hard stop (no device).
async function handleSecondFactor(page, shot, mfa, log) {
  try {
    // Unautomatable factors first — a push/number/SMS prompt can't be satisfied headless.
    if (await page.locator(SELECTORS.pushChallenge).first().isVisible().catch(() => false)) {
      return { bail: { ok: false, error: "the login requires push / number-matching / SMS MFA — a headless bot can't approve that. Switch the automation account to app (authenticator) MFA and enable One-Time Password on its Delinea secret, or complete the sign-in manually.", evidence: await shot("mfa-push") } };
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
        return { bail: { ok: false, error: "the login requires MFA but no code was available — enable One-Time Password on the secret in Delinea (paste the authenticator seed there once); the runner then fetches a fresh code at the MFA prompt. Or complete the sign-in manually.", evidence: await shot("mfa-no-code") } };
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
      ? "check the seed on the secret and that the automation account uses app/TOTP MFA (not push/SMS)"
      : "the account's MFA may not be the authenticator this Delinea secret holds (re-pair the authenticator into the secret's One-Time Password)";
    await scrubOtpField(page);
    return { bail: { ok: false, error: `the one-time code was rejected — ${hint}.`, evidence: await shot("otp-rejected") } };
  } catch (e) {
    await scrubOtpField(page);
    return { bail: { ok: false, error: `second-factor handling failed: ${e?.message ?? e}`, evidence: await shot("mfa-error") } };
  }
}

// Complete Microsoft's own sign-in pages: username -> (submit if needed) -> password -> submit ->
// second factor -> the MS error-box gate -> the "Stay signed in?" (KMSI) interstitial. Assumes the
// page is ALREADY on (or about to render) a Microsoft sign-in view — callers own getting there (a
// portal's "Log in with Microsoft" button, a device-code prompt, a direct
// login.microsoftonline.com navigation, ...) and own detecting their OWN post-login success
// condition (there is no built-in "wait for the redirect back to caller origin" here — no current
// caller redirects to a third-party origin after this completes).
//
// input: { username, password, params: { otp, otpCode, totpSeed } } — the SAME shape
// spanning-force-sync's input.params carries (otp = { url, token, agentId, secretName }, the
// preferred Delinea-mint-at-the-prompt request spec; otpCode/totpSeed are legacy fallbacks).
export async function signInMicrosoft({ page, shot, input, log }) {
  const username = input?.username ?? null;
  const password = input?.password ?? null; // NEVER logged
  const mfaSources = {
    otpReq: input?.params?.otp ?? null,
    otpCode: input?.params?.otpCode ?? null, // pre-minted code (legacy runner) — likely stale, kept as fallback
    totpSeed: input?.params?.totpSeed ?? input?.totpSeed ?? null, // legacy stored seed
  };

  if (!username || !password) {
    return { ok: false, error: "no Microsoft sign-in credentials brokered (username/password) — set them on the client's secret" };
  }

  try {
    const pwField = page.locator(SELECTORS.password).first();
    const userField = page.locator(SELECTORS.username).first();
    if (await onActiveView(userField)) {
      log("entering the Microsoft sign-in username");
      await userField.fill(username);
      // Some tenants split username/password across two steps — submit to advance if the password
      // box is not up yet. This asks onActiveView, NOT isVisible: Microsoft's password field is
      // already in the DOM at this point.
      if (!(await onActiveView(pwField))) {
        await page.locator(SELECTORS.submit).first().click().catch(() => {});
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        await waitForCondition(page, () => onActiveView(pwField), 20_000);
      }
    }

    if (!(await onActiveView(pwField))) {
      // No password field — could be an MFA-first / passwordless prompt. Let the second-factor handler
      // report precisely (push vs code vs unknown) instead of a generic "no password field".
      const mfa = await handleSecondFactor(page, shot, mfaSources, log);
      if (mfa.bail) return mfa.bail;
      return { ok: false, error: "could not find the password field on the Microsoft sign-in page — VERIFY the selectors against the real console", evidence: await shot("no-password-field") };
    }
    log("entering the Microsoft sign-in password"); // the VALUE is never logged
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
    // the admin account (halving the Entra smart-lockout runway) and navigating away before the error
    // could be read.
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
    // onward. Left unanswered, the browser parks on login.microsoftonline.com.
    //
    // Identify it by the PAGE, not by a button id: #idSIButton9 is Microsoft's GENERIC submit id (it's
    // "Next" on the username page, "Sign in" on the password page, "Yes" here), and a bare
    // `button:has-text("Yes")` would happily match something else entirely — including a caller's own
    // page once we're back on it. We require the KMSI form itself to be present, then click its
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

    // Still on the ACTIVE password view after submit ⇒ the login was rejected (or the selectors are
    // wrong). onActiveView, not isVisible: once Microsoft moves on to the MFA step it parks this same
    // password field in its aria-hidden container, which isVisible() still calls visible — that would
    // report a sign-in sitting at a legitimate MFA prompt as a failed login.
    if (await onActiveView(pwField)) {
      return { ok: false, error: "Microsoft sign-in did not succeed (still on the login page) — check the brokered credentials, or VERIFY the login selectors", evidence: await shot("login-failed") };
    }
  } catch (e) {
    return { ok: false, error: `Microsoft sign-in failed: ${e?.message ?? e}`, evidence: await shot("login-error") };
  }

  return { ok: true };
}
