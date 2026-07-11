// Shared Playwright Chromium launcher for the runner's browser flows. Headless, with sane timeouts
// and a screenshot-on-failure helper. Kept dependency-light: only @playwright/test's `chromium`.
//
// Nothing here logs credentials. Flows receive `input` (which may carry a password) but this module
// never prints it.
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";

// Conservative defaults — a portal login + one action shouldn't need more than this, and a runner
// job that hangs on a wedged browser is worse than one that fails fast with a clear timeout.
export const DEFAULT_NAV_TIMEOUT_MS = 30_000;
export const DEFAULT_ACTION_TIMEOUT_MS = 20_000;

// Launch a headless Chromium and hand back { browser, context, page } plus a `shot()` helper that
// screenshots to a temp file (for evidence-on-failure). The caller MUST call close() in a finally.
export async function launch({ navTimeoutMs = DEFAULT_NAV_TIMEOUT_MS, actionTimeoutMs = DEFAULT_ACTION_TIMEOUT_MS } = {}) {
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  } catch (e) {
    // The most common cause is a missing browser binary — make the fix actionable.
    const hint = /Executable doesn.t exist|Failed to launch|install/i.test(String(e?.message))
      ? " — run `npx playwright install chromium` on this host"
      : "";
    throw new Error(`could not launch Chromium${hint}: ${e?.message ?? e}`);
  }
  // From here the browser IS launched — if context/page creation throws, close it or the Chromium
  // process leaks (the caller has no handle yet, so its finally can't clean up).
  let context, page;
  try {
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    context.setDefaultNavigationTimeout(navTimeoutMs);
    context.setDefaultTimeout(actionTimeoutMs);
    page = await context.newPage();
  } catch (e) {
    try { await browser.close(); } catch { /* ignore */ }
    throw new Error(`could not open a browser context: ${e?.message ?? e}`);
  }

  // Screenshot to a temp path for failure evidence. Best-effort — never throws (evidence is a nice
  // to have; a screenshot failure must not mask the real error).
  async function shot(label = "failure") {
    try {
      const safe = String(label).replace(/[^a-z0-9_-]+/gi, "-").slice(0, 40);
      const file = path.join(os.tmpdir(), `ctg-browser-${safe}-${Date.now()}.png`);
      await page.screenshot({ path: file, fullPage: true });
      return file;
    } catch {
      return null;
    }
  }

  async function close() {
    try { await context.close(); } catch { /* ignore */ }
    try { await browser.close(); } catch { /* ignore */ }
  }

  return { browser, context, page, shot, close };
}
