// Flow: slack-console-setup
// ---------------------------------------------------------------------------------------------
// Sign in to Slack (as an admin, from a `slack-console` email+password login, clearing a TOTP prompt
// by minting the code at the prompt) and BEST-EFFORT locate/harvest a SCIM token — the `slack` API
// credential (a single bearer token with the admin scope). Modeled on zoom-console-setup.mjs /
// mimecast-console-signin.mjs (the runner harvests, the APP vaults). `params.signInOnly:true` proves
// the login works and changes nothing (the "Test sign-in" affordance).
//
// !!! IMPORTANT CAVEAT — Slack differs from the other vendors !!!
// A Slack SCIM token is NOT generated from a simple console button/field the way Zoom/Adobe API creds
// are. It comes from a Slack app / OAuth install carrying the `admin` scope (Enterprise Grid /
// Business+), and is generally NOT readable by clicking through a console page. So this flow's harvest
// step is a genuine BEST EFFORT: it signs in, navigates toward the app/SCIM surface, and returns a
// token ONLY if one happens to be exposed as a readable field. In practice the operator creates the
// SCIM token and PASTES it via the guided form — that paste-and-vault path (unchanged) is the reliable
// primary. This flow never fabricates a token; a "no token found" result is expected and handled
// gracefully upstream (the route tells the operator to paste).
//
// Slack sign-in is ALSO uncertain to automate: many workspaces use SSO or email magic-links (no
// password), which a headless browser cannot complete. Those tenants must paste too.
//
// LIVE-VALIDATION PENDING: never exercised against the live Slack console (no Chromium here). Every
// selector is a resilient best-effort union tagged with its location, and each step logs its stage.
// Harvested values are NEVER logged.
import { onActiveView, waitForCondition } from "../lib/ms-sso-login.mjs";
import { totp } from "../lib/totp.mjs";

const DEFAULT_SIGNIN_URL = "https://slack.com/signin";
// Where an admin-scope app / SCIM token would live if exposed. Best-effort landing pages.
const APPS_URL = "https://api.slack.com/apps";

const S = {
  // Slack sign-in is workspace-first: a workspace-URL field, then email + password (when not SSO).
  workspace: 'input[name="domain"], input[data-qa="signin_domain_input"], input[placeholder*="workspace" i], input[placeholder*="url" i]',
  workspaceNext: 'button[type="submit"], button:has-text("Continue"), button:has-text("Next")',
  email: 'input[type="email"], input[name="email"], input[data-qa="login_email"], input[autocomplete="username"]',
  password: 'input[type="password"], input[name="password"], input[data-qa="login_password"], input[autocomplete="current-password"]',
  signIn: 'button[type="submit"], button:has-text("Sign in"), button:has-text("Sign In"), [data-qa="signin_button"]',
  totp: 'input[autocomplete="one-time-code"], input[name*="2fa" i], input[name*="otp" i], input[name*="code" i], input[inputmode="numeric"]',
  totpNext: 'button[type="submit"], button:has-text("Verify"), button:has-text("Confirm"), button:has-text("Continue")',
  error: '[role="alert"]:visible, [data-qa*="error" i]:visible, .error:visible, [class*="error" i]:visible',
  // A readable token field IF one is ever exposed (best-effort — most Slack tokens are not shown here).
  tokenField: 'input[readonly][value^="xoxp-" i], input[readonly][value^="xoxb-" i], code:has-text("xox"), input[readonly][id*="token" i], [data-qa*="token" i] input[readonly]',
};

// -------------------------------------------------------------------------------------------------
// PURE HELPERS (unit-testable; no browser)
// -------------------------------------------------------------------------------------------------

// Does `urlStr` look like a signed-in Slack page (past the sign-in screen)? True on a slack.com host
// whose path isn't a /signin|/signout route. Tolerant: a non-URL yields false.
export function looksSignedIn(urlStr) {
  try {
    const u = new URL(urlStr);
    const host = u.hostname.toLowerCase();
    if (!(host.endsWith("slack.com"))) return false;
    if (/(^|\/)(signin|signout|login|sso)(\/|$)/i.test(u.pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

// A harvested token looks like a Slack bearer token (xoxp-/xoxb-/xoxa-) and is non-trivial.
export function looksLikeSlackToken(t) {
  return typeof t === "string" && /^xox[abpr]-[A-Za-z0-9-]{8,}$/i.test(t.trim());
}

async function mintOtp(otpReq, log) {
  try {
    if (otpReq?.otpCode) return String(otpReq.otpCode);
    if (otpReq?.totpSeed) return totp(otpReq.totpSeed);
  } catch (e) {
    log?.(`could not generate the Slack TOTP code: ${e?.message ?? e}`);
  }
  return "";
}

async function signInSlack({ page, shot, input, log }) {
  const username = input?.username;
  const password = input?.password;
  if (!username || !password) {
    return { ok: false, error: "no Slack console credentials brokered (email/password) — wire a 'slack-console' secret with an admin email + password. (SSO/magic-link workspaces cannot use this flow — paste the SCIM token instead.)" };
  }
  try {
    // Optional workspace-URL step (from params.workspace or derived — best-effort; skipped if absent).
    const wsField = page.locator(S.workspace).first();
    const workspace = input?.params?.workspace;
    if (workspace && (await waitForCondition(() => onActiveView(wsField), 8000))) {
      await wsField.fill(String(workspace));
      await page.locator(S.workspaceNext).first().click().catch(() => {});
      await page.waitForTimeout(1500);
    }

    const emailField = page.locator(S.email).first();
    if (await waitForCondition(() => onActiveView(emailField), 15000)) {
      await emailField.fill(username);
    }
    if (looksSignedIn(page.url())) return { ok: true };

    const pwField = page.locator(S.password).first();
    if (!(await waitForCondition(() => onActiveView(pwField), 12000))) {
      return { ok: false, error: "could not reach the Slack password field — the workspace likely uses SSO or an email magic-link (not automatable). VERIFY against the live console, or paste the SCIM token.", evidence: await shot("slack-no-password") };
    }
    await pwField.fill(password);
    await page.locator(S.signIn).first().click().catch(() => {});
    await page.waitForTimeout(1800);

    const earlyErr = await page.locator(S.error).first().innerText().catch(() => "");
    if (earlyErr && !looksSignedIn(page.url())) {
      return { ok: false, error: `Slack rejected the sign-in: ${earlyErr.trim()}`, evidence: await shot("slack-password-error") };
    }

    const otpField = page.locator(S.totp).first();
    if (await onActiveView(otpField)) {
      const code = await mintOtp(input?.params?.otp, log);
      if (!code) {
        return { ok: false, error: "Slack asked for a verification code but none was available — enable One-Time Password on the 'slack-console' secret, or sign in manually.", evidence: await shot("slack-mfa-no-code") };
      }
      await otpField.fill(code);
      await page.locator(S.totpNext).first().click().catch(() => {});
      await page.waitForTimeout(2000);
      const otpErr = await page.locator(S.error).first().innerText().catch(() => "");
      if (otpErr && !looksSignedIn(page.url())) {
        return { ok: false, error: `the Slack verification code was rejected: ${otpErr.trim()}`, evidence: await shot("slack-mfa-rejected") };
      }
    }

    if (!looksSignedIn(page.url())) {
      return { ok: false, error: "the sign-in completed the password/code steps but did not reach a signed-in Slack page — VERIFY the flow against the live console (SSO interstitial?), or paste the token.", evidence: await shot("slack-no-console") };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Slack sign-in failed: ${e?.message ?? e}`, evidence: await shot("slack-login-error") };
  }
}

// BEST-EFFORT harvest: look for a readable token field on the apps/SCIM surface. Usually finds nothing
// (Slack does not expose SCIM tokens as console fields) — returns "" so the app tells the operator to
// paste. NEVER logs the value.
async function tryHarvestToken({ page, log }) {
  try {
    await page.goto(APPS_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(1500);
    const el = page.locator(S.tokenField).first();
    if (!(await el.count().catch(() => 0))) { log("no readable SCIM-token field on the console (expected — Slack tokens come from an app install)"); return ""; }
    const raw = ((await el.inputValue().catch(() => "")) || (await el.getAttribute("value").catch(() => "")) || (await el.innerText().catch(() => ""))).trim();
    if (looksLikeSlackToken(raw)) { log("found a readable Slack token on the console"); return raw; } // value NEVER logged
    return "";
  } catch (e) {
    log(`token-harvest attempt errored (non-fatal): ${e?.message ?? e}`);
    return "";
  }
}

// -------------------------------------------------------------------------------------------------
// ENTRY
// -------------------------------------------------------------------------------------------------
export default async function slackConsoleSetup({ page, shot, input, log }) {
  const signInOnly = input?.params?.signInOnly !== false; // default sign-in-only
  const signinUrl = (input?.params?.consoleUrl && String(input.params.consoleUrl).trim()) || DEFAULT_SIGNIN_URL;

  try {
    await page.goto(signinUrl, { waitUntil: "domcontentloaded" });
  } catch (e) {
    return { ok: false, error: `could not reach the Slack sign-in (${signinUrl}): ${e?.message ?? e}`, evidence: await shot("nav") };
  }

  const signIn = await signInSlack({ page, shot, input, log });
  if (!signIn.ok) return signIn;

  if (signInOnly) return { ok: true, message: "signed in to Slack" };

  const token = await tryHarvestToken({ page, log });
  if (token) return { ok: true, message: "signed in to Slack and harvested a SCIM token", harvested: { token } };
  // Signed in, but nothing harvestable — expected for Slack. Success (login proven), no credential.
  return { ok: true, message: "signed in to Slack, but no SCIM token was console-harvestable — paste the token via the guided form" };
}
