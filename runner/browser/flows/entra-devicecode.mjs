// Flow: entra-devicecode
// ---------------------------------------------------------------------------------------------
// Complete Microsoft's device-login page (https://microsoft.com/devicelogin) as a Global Admin: type
// in the device code shown at the sign-in prompt, sign in through the normal MS-SSO sequence
// (username -> password -> MFA -> KMSI), then confirm the final "you're signed in" / app-consent
// page. This is the browser half of an Entra device-code flow — the code itself is generated
// elsewhere (Graph device-code auth) and handed to us as input.params.userCode.
//
// Reuses the proven MS-SSO login machinery (the aria-hidden-safe onActiveView, the MFA state
// machine, the error gate, KMSI) from ../lib/ms-sso-login.mjs — a fresh, faithful copy of the same
// logic that lives in flows/spanning-force-sync.mjs (live-validated; deliberately not touched or
// imported from here). LIVE-VALIDATION OF THIS FLOW IS PENDING — it cannot be exercised with
// Playwright in this environment; the selectors below are Microsoft's documented/stable field names
// for the device-code page, following the same resilient-selector style as the rest of this dir.
//
// SELECTOR-COLLISION GUARD: the devicelogin code box and the LATER sign-in MFA/OTP box both use
// Microsoft's `otc` field name (ms-sso-login.mjs's SELECTORS.otpInput matches it too). Blindly
// handing off to signInMicrosoft() a fixed delay after clicking Next on the devicelogin page risked
// still being ON that same devicelogin page (code rejected/slow) when handleSecondFactor() runs —
// it would find input[name="otc"] "visible", assume it's an MFA prompt, and mint+burn a REAL Delinea
// one-time password into the device-code box. We only ever call signInMicrosoft() once the
// username field on the REAL sign-in page is confirmed active (onActiveView), never on a fixed
// timeout — see step 1 below.
import { signInMicrosoft, waitForCondition, onActiveView, SELECTORS as MS_SELECTORS } from "../lib/ms-sso-login.mjs";

const DEVICE_LOGIN_URL = "https://microsoft.com/devicelogin";

const SELECTORS = {
  // The "Enter the code displayed on your app or device" page. Microsoft's own field name for this
  // box is `otc` (one-time-code) — the SAME name used later for the MFA/OTP box on the sign-in SSO
  // pages. See the selector-collision guard above for why that matters.
  codeInput: 'input[name="otc"], input#otc, input[type="tel"]',
  codeNext: '#idSIButton9, button:has-text("Next"), input[type="submit"], button[type="submit"]',
  // Microsoft's own "that code isn't right / has expired" wording on the devicelogin page itself
  // (distinct from the MS-SSO sign-in error box in ms-sso-login.mjs, which only appears later).
  codeError: 'text=/that code (isn\'t|is not) (correct|valid)|code has expired|enter the code again|expired.{0,20}(code|device)|try (signing in )?again|something went wrong|too many (people|attempts)/i',
  // The final confirmation after a successful device-code sign-in: either an app-consent screen
  // ("Continue"/"Yes") or a bare "you have signed in, you can close this window" page with no button
  // at all (already-consented apps skip the consent screen entirely).
  confirmButton: '#idSIButton9, button:has-text("Continue"), button:has-text("Yes"), button:has-text("Done"), button[type="submit"], input[type="submit"]',
  confirmedText: 'text=/you.?(have|are|\'ve) (successfully )?signed in|you can close this (window|tab)|sign-in is complete|you are now signed in/i',
};

export default async function entraDeviceCode({ page, shot, input, log }) {
  const userCode = input?.params?.userCode ?? null;
  if (!userCode) {
    return { ok: false, error: "no device code was provided (params.userCode) — the app must supply the code shown at the device sign-in prompt" };
  }

  // 1. Navigate to the device-login page and enter the code.
  try {
    log(`navigating to ${DEVICE_LOGIN_URL}`);
    await page.goto(DEVICE_LOGIN_URL, { waitUntil: "domcontentloaded" });
  } catch (e) {
    return { ok: false, error: `could not reach ${DEVICE_LOGIN_URL}: ${e?.message ?? e}`, evidence: await shot("nav") };
  }

  try {
    const codeField = page.locator(SELECTORS.codeInput).first();
    const gotField = await waitForCondition(page, () => codeField.isVisible().catch(() => false), 20_000);
    if (!gotField) {
      return { ok: false, error: "could not find the device-code entry field on microsoft.com/devicelogin — VERIFY the page/selectors against the live console", evidence: await shot("no-code-field") };
    }
    log("entering the device code");
    await codeField.fill(String(userCode));
    await page.locator(SELECTORS.codeNext).first().click().catch(() => {});
    await page.waitForLoadState("domcontentloaded").catch(() => {});

    // Do NOT hand off to signInMicrosoft() on a fixed timeout — that's the selector-collision trap
    // (see the header comment). Wait for one of two DISTINGUISHABLE outcomes: (a) the real MS-SSO
    // sign-in has begun — its username field is active, per onActiveView — or (b) the devicelogin
    // page itself reports the code wasn't recognized/expired. Only (a) is safe to hand to
    // signInMicrosoft(); handleSecondFactor() there must never run against the devicelogin otc box.
    const usernameField = page.locator(MS_SELECTORS.username).first();
    const codeErrorLocator = page.locator(SELECTORS.codeError).first();
    const advanced = await waitForCondition(page, () => onActiveView(usernameField), 20_000);
    if (!advanced) {
      const hasError = await codeErrorLocator.isVisible().catch(() => false);
      const evidence = await shot("device-code-not-recognized");
      return {
        ok: false,
        error: hasError
          ? "device code not recognized or expired"
          : "device code not recognized or expired (the page did not advance to the Microsoft sign-in username field within 20s)",
        evidence,
      };
    }
  } catch (e) {
    return { ok: false, error: `could not submit the device code: ${e?.message ?? e}`, evidence: await shot("code-entry-error") };
  }

  // 2. Sign in as the Global Admin through the shared MS-SSO machinery (username/password/MFA/KMSI).
  //    The username field is confirmed active at this point (checked above), so we're in the real
  //    sign-in context, not still on the devicelogin otc box. A device-code confirmation stays on a
  //    Microsoft domain rather than redirecting to a third-party origin, so we just move on to our
  //    own post-login wait below.
  const signIn = await signInMicrosoft({ page, shot, input, log });
  if (!signIn.ok) return signIn; // bail through its structured error result unchanged

  // 3. Confirm the device sign-in — click the consent/"Continue" button if one appears, or accept the
  //    bare "you're signed in" confirmation text when the app was already consented.
  try {
    const confirmBtn = page.locator(SELECTORS.confirmButton).first();
    const confirmText = page.locator(SELECTORS.confirmedText).first();
    const settled = await waitForCondition(page, async () => (
      (await confirmBtn.isVisible().catch(() => false)) || (await confirmText.isVisible().catch(() => false))
    ), 30_000);
    if (!settled) {
      return { ok: false, error: "device sign-in did not reach a confirmation page — VERIFY the flow against the live console", evidence: await shot("no-confirmation") };
    }
    if (await confirmBtn.isVisible().catch(() => false)) {
      log("confirming the device sign-in");
      await confirmBtn.click().catch(() => {});
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(1000);
    }
    return { ok: true, message: "device login complete", evidence: await shot("device-login-complete") };
  } catch (e) {
    return { ok: false, error: `could not complete the device sign-in confirmation: ${e?.message ?? e}`, evidence: await shot("confirm-error") };
  }
}
