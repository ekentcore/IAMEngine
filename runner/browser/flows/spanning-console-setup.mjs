// Flow: spanning-console-setup
// ---------------------------------------------------------------------------------------------
// Sign into the Spanning Backup admin console (Microsoft-365 SSO) and generate + HARVEST the
// Settings → API Token, which the app then vaults as the `spanning` API credential. This is the
// setup analog of spanning-force-sync (which uses the SAME M365 SSO login); here we don't sync — we
// read the API key so onboarding/offboarding can use the Spanning API without a human copying it.
//
// The M365 SSO sign-in reuses the shared, live-verified helper runner/browser/lib/ms-sso-login.mjs
// (same machinery spanning-force-sync relies on) — so only the POST-login Spanning navigation +
// token harvest below is new, and it is the part that NEEDS LIVE SELECTOR VALIDATION against the
// real console (no live console was reachable when this was written).
//
// input:  { username, password, params: { otp?, consoleUrl?, signInOnly? } }  (creds NEVER logged)
// result: { ok:true, Credentials:{ apiToken } }  — the token rides a `Credentials` note-property the
//         app scrubs after vaulting; on signInOnly it's omitted. { ok:false, error, evidence } on fail.
import { signInMicrosoft } from "../lib/ms-sso-login.mjs";

const DEFAULT_PORTAL_URL = "https://o365.spanningbackup.com/login.html";
const portalUrl = (input) => (input?.params?.consoleUrl || process.env.SPANNING_PORTAL_URL || DEFAULT_PORTAL_URL);

// Post-login Spanning console selectors — BEST-EFFORT, each commented with where it lives in the UI.
// VERIFY against the live console: the exact route to the API Token panel and the field/button labels.
const SEL = {
  // The provider chooser on o365.spanningbackup.com before MS SSO takes over ("Log In with Microsoft").
  msProvider: 'button:has-text("Microsoft"), a:has-text("Log In with Microsoft"), a:has-text("Microsoft 365"), [data-provider="microsoft"]',
  // Settings entry (top-nav or gear). Spanning's console: Settings link/gear.
  settingsLink: 'a:has-text("Settings"), a[href*="settings" i], button:has-text("Settings"), [aria-label="Settings"]',
  // The API Token section lives at the BOTTOM of Settings. Anchor + the key field + generate button.
  apiTokenSection: 'text=/API Token/i',
  apiKeyField: 'input[name*="token" i], input[id*="token" i], input[readonly][value], code:has-text("-"), [data-testid*="api-token" i]',
  generateBtn: 'button:has-text("Generate"), button:has-text("Create Token"), button:has-text("New Token")',
  // Regenerate is DESTRUCTIVE (invalidates the current key everywhere) — never click it; only Generate
  // when no key exists.
  regenerateBtn: 'button:has-text("Regenerate")',
};

async function harvestApiToken(page, shot, log) {
  log("navigating to Settings → API Token");
  // Open Settings.
  const settings = page.locator(SEL.settingsLink).first();
  if (await settings.isVisible().catch(() => false)) {
    await settings.click().catch(() => {});
    await page.waitForLoadState("domcontentloaded").catch(() => {});
  }
  // Scroll to the API Token section (bottom of the page).
  const section = page.locator(SEL.apiTokenSection).first();
  await section.scrollIntoViewIfNeeded().catch(() => {});

  // Read an existing key if one is already displayed; else Generate one (never Regenerate).
  const readKey = async () => {
    const field = page.locator(SEL.apiKeyField).first();
    if (!(await field.isVisible().catch(() => false))) return "";
    const val = (await field.inputValue().catch(() => null)) ?? (await field.textContent().catch(() => null));
    const t = (val ?? "").trim();
    return t && t.length >= 12 ? t : ""; // a real key, not a placeholder
  };

  let token = await readKey();
  if (!token) {
    const gen = page.locator(SEL.generateBtn).first();
    if (await gen.isVisible().catch(() => false)) {
      log("no existing API key found — generating one");
      await gen.click().catch(() => {});
      await page.waitForTimeout(2000);
      token = await readKey();
    }
  }
  if (!token) {
    return { ok: false, error: "signed in, but could not read or generate the Spanning API Token — VERIFY the Settings → API Token selectors against the live console", evidence: await shot("no-api-token") };
  }
  // The token is returned note-only; NEVER logged.
  return { ok: true, Credentials: { apiToken: token } };
}

export default async function spanningConsoleSetup({ page, shot, input, log }) {
  const signInOnly = input?.params?.signInOnly === true;
  try {
    log(`opening the Spanning admin console`);
    await page.goto(portalUrl(input), { waitUntil: "domcontentloaded" }).catch(() => {});
    // Provider chooser → Microsoft, then the shared MS SSO login handles username/password/MFA.
    const provider = page.locator(SEL.msProvider).first();
    if (await provider.isVisible().catch(() => false)) {
      log('choosing "Log In with Microsoft"');
      await provider.click().catch(() => {});
      await page.waitForLoadState("domcontentloaded").catch(() => {});
    }
  } catch (e) {
    return { ok: false, error: `could not open the Spanning console: ${e?.message ?? e}`, evidence: await shot("open-failed") };
  }

  const login = await signInMicrosoft({ page, shot, input, log });
  if (!login.ok) return login;

  if (signInOnly) {
    log("sign-in test succeeded (no changes made)");
    return { ok: true };
  }
  return harvestApiToken(page, shot, log);
}
