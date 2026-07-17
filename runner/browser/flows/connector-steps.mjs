// Flow: connector-steps
// ---------------------------------------------------------------------------------------------
// Generic interpreter for a DECLARATIVE browser connector (docs/CONNECTOR_BUILDER.md). Instead of a
// hand-written .mjs per portal, the app hands us a definition (startUrl, host allowlist, and a lane
// of steps) plus the case context, and we drive Playwright from it. One flow serves every browser
// connector; adding a new portal is authoring data in the builder, not code here.
//
// Security (mirrors the http executor + the spanning flow's origin gate):
//   * HOST ALLOWLIST — every navigation target (and the page we're on before typing a secret) must
//     be the startUrl host or one explicitly listed in definition.hosts. A step cannot send the
//     browser — or a `secret:true` value — to a host the author didn't declare. Suffix/prefix
//     confusion is rejected (exact host or a real dotted subdomain).
//   * SECRET REDACTION — a `secret:true` fill value never reaches a log line; only booleans and the
//     step type/target are ever printed.
//   * NO ARBITRARY CODE — steps are a fixed vocabulary; an unknown type fails the flow.
//
// input = {
//   username, password,           // the portal secret ({{secret.username}} / {{secret.password}})
//   params: {
//     definition,                 // { startUrl, hosts?, lanes }
//     lane,                       // "onboard" | "offboard" | "test"
//     user, config,               // case payload / lane config, for {{user.*}} / {{config.*}}
//     totpSeed,                   // optional base32 seed for {{}} `totp` steps
//     allowAnyOrigin              // test escape hatch (localhost harness) — never set in prod
//   }
// }

import { totp } from "../lib/totp.mjs";

const PLACEHOLDER_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

// Resolve a dotted path against the context; absent → undefined (never throws).
function getPath(ctx, path) {
  let cur = ctx;
  for (const seg of String(path).split(".")) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

// Replace every {{root.path}} in a string. An unresolvable placeholder throws — silently substituting
// empty could type "" where a value was required, or navigate to a truncated URL.
function resolveTemplate(text, ctx) {
  if (text == null) return text;
  return String(text).replace(PLACEHOLDER_RE, (_, path) => {
    const v = getPath(ctx, path.trim());
    if (v == null) throw new Error(`template {{${path.trim()}}} did not resolve`);
    return String(v);
  });
}

// Exact host, or a real dotted subdomain of an allowed host. Rejects suffix ("evilvendor.com" vs
// "vendor.com") and prefix ("vendor.com.evil.com") confusion.
function hostAllowed(href, allowedHosts, allowAny) {
  try {
    const u = new URL(href);
    if (allowAny) return true; // localhost test harness escape hatch — never set in prod
    if (u.protocol !== "https:") return false; // never type a credential over cleartext http
    const h = u.hostname.toLowerCase();
    return allowedHosts.some((a) => h === a || h.endsWith(`.${a}`));
  } catch {
    return false;
  }
}

// Build a Playwright locator from a step target (exactly one selector key, validated app-side too).
function locator(page, target, ctx) {
  if (!target || typeof target !== "object") throw new Error("step target is missing");
  const name = target.name != null ? resolveTemplate(target.name, ctx) : undefined;
  if (target.css != null) return page.locator(resolveTemplate(target.css, ctx));
  if (target.testId != null) return page.getByTestId(resolveTemplate(target.testId, ctx));
  if (target.label != null) return page.getByLabel(resolveTemplate(target.label, ctx));
  if (target.placeholder != null) return page.getByPlaceholder(resolveTemplate(target.placeholder, ctx));
  if (target.text != null) return page.getByText(resolveTemplate(target.text, ctx));
  if (target.role != null) return page.getByRole(resolveTemplate(target.role, ctx), name != null ? { name } : undefined);
  throw new Error("step target set no known selector (css/role/label/placeholder/text/testId)");
}

function describeTarget(target) {
  if (!target) return "";
  const key = ["css", "role", "label", "placeholder", "text", "testId"].find((k) => target[k] != null);
  return key ? `${key}=${target[key]}${target.name ? `[name=${target.name}]` : ""}` : "";
}

export default async function run({ page, shot, input, log }) {
  const p = input?.params ?? {};
  const def = p.definition ?? {};
  const lane = p.lane;
  const steps = def?.lanes?.[lane];
  if (!Array.isArray(steps)) {
    return { ok: false, error: `connector browser definition has no '${lane}' lane` };
  }

  // Allowlist = startUrl host + any explicitly listed hosts.
  const allowedHosts = [];
  try { allowedHosts.push(new URL(def.startUrl).hostname.toLowerCase()); } catch { /* validated app-side */ }
  for (const h of def.hosts ?? []) allowedHosts.push(String(h).toLowerCase());
  const allowAny = p.allowAnyOrigin === true;

  // Template context. `secret` exposes the brokered portal credential; def exposes definition fields.
  const ctx = {
    user: p.user ?? {},
    payload: p.user ?? {},
    config: p.config ?? {},
    client: p.client ?? {},
    vars: {},
    def,
    secret: { username: input?.username ?? "", password: input?.password ?? "" },
  };

  const assertHost = (href, what) => {
    if (!hostAllowed(href, allowedHosts, allowAny)) {
      throw new Error(`${what} host is not in the connector's allowlist (${allowedHosts.join(", ") || "none"}) — refusing`);
    }
  };

  let last = "start";
  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const type = step?.type;
      const timeout = Number.isInteger(step?.timeoutMs) ? step.timeoutMs : undefined;
      last = `${type} ${describeTarget(step?.target)}`.trim();
      log(`step ${i + 1}/${steps.length}: ${type} ${describeTarget(step?.target)}`); // never the value

      switch (type) {
        case "goto": {
          const url = resolveTemplate(step.url, ctx);
          assertHost(url, "navigation");
          await page.goto(url, { waitUntil: "domcontentloaded", ...(timeout ? { timeout } : {}) });
          // page.goto follows server redirects and only the REQUESTED url was checked — re-assert the
          // FINAL landing page, so a login page that 302s off-allowlist can't then receive input.
          assertHost(page.url(), "page after navigation");
          break;
        }
        case "fill": {
          // Assert the current page UNCONDITIONALLY before any fill — not just when the author flagged
          // the step secret. A fill of {{secret.password}} with the flag forgotten (the codegen import
          // emits plain fills) must never type the credential onto a page that redirected off-allowlist.
          assertHost(page.url(), "current page (before typing into it)");
          const value = resolveTemplate(step.value, ctx);
          await locator(page, step.target, ctx).fill(value, timeout ? { timeout } : undefined);
          break;
        }
        case "click":
          assertHost(page.url(), "current page (before clicking)");
          await locator(page, step.target, ctx).click(timeout ? { timeout } : undefined);
          break;
        case "press":
          assertHost(page.url(), "current page (before typing)");
          await locator(page, step.target, ctx).press(resolveTemplate(step.value, ctx), timeout ? { timeout } : undefined);
          break;
        case "select":
          assertHost(page.url(), "current page (before selecting)");
          await locator(page, step.target, ctx).selectOption(resolveTemplate(step.value, ctx), timeout ? { timeout } : undefined);
          break;
        case "totp": {
          if (!p.totpSeed) throw new Error("a totp step needs a TOTP seed on the connector's secret, but none was brokered");
          assertHost(page.url(), "current page (before entering an MFA code)");
          const code = totp(p.totpSeed);
          await locator(page, step.target, ctx).fill(code, timeout ? { timeout } : undefined);
          break;
        }
        case "waitFor":
          await locator(page, step.target, ctx).waitFor(timeout ? { timeout } : undefined);
          break;
        case "expect": {
          // An expectation that never appears fails the step (the target's own timeout bounds the wait).
          try {
            await locator(page, step.target, ctx).waitFor({ state: "visible", ...(timeout ? { timeout } : {}) });
          } catch {
            const evidence = await shot(`connector-expect-${i + 1}`);
            return { ok: false, error: `expected ${describeTarget(step.target)} to appear, but it did not`, evidence };
          }
          break;
        }
        case "sleep":
          await page.waitForTimeout(Math.min(60_000, Math.max(0, Number(step.ms) || 0)));
          break;
        case "screenshot":
          await shot(`connector-step-${i + 1}`);
          break;
        default:
          throw new Error(`unknown step type '${type}'`);
      }
    }
    const evidence = await shot("connector-done");
    return { ok: true, message: `ran ${steps.length} step(s) for the ${lane} lane`, evidence };
  } catch (e) {
    const evidence = await shot("connector-fail");
    // e.message is our own text or Playwright's (selector/timeout) — never a credential (we log types,
    // and secret values are only ever passed to .fill(), never interpolated into a message).
    return { ok: false, error: `browser step failed (${last}): ${e?.message ?? e}`, evidence };
  }
}
