// Flow: connector-login
// ---------------------------------------------------------------------------------------------
// The browser half of a HYBRID (browser-session) http connector. It signs in to a portal in a
// headless browser using the declarative login steps, then HARVESTS the resulting session — a named
// cookie set, or a token stashed in localStorage — and returns it so the PowerShell side can attach
// it to the connector's ordinary http operations. Its whole reason to exist is the portal whose API
// is real but authenticated by a browser session rather than a static credential (exactly what the
// HAR-import credential probe flags as "auth-rejected / redirected to login").
//
// Security — the login steps run through the SAME executeSteps() as a browser connector, so the host
// allowlist is re-asserted before every navigation and every fill (a credential is never typed onto a
// page that redirected off-allowlist). Two harvest-specific rules on top:
//   * The harvest reads state (cookies / localStorage) only AFTER the login steps succeed, and the
//     current page must be on an allowlisted host at harvest time — a redirect to an unlisted host is
//     a failed login, not a place to read a token from.
//   * Only the cookies NAMED in harvest.cookies (or the single storageKey) are read back; nothing
//     else from the browser state leaves this process.
//
// The harvested session travels back on the single stdout result line (run-flow's `session` field),
// captured by PowerShell and registered for redaction — never logged here.
//
// input = {
//   username, password,          // the portal login secret
//   params: {
//     definition: { hosts, login, harvest },   // harvest = { cookies:[names] } | { storageKey:name }
//     user, config, client,      // case context for {{user.*}} etc. in login steps
//     totpSeed,                  // optional base32 seed for `totp` login steps
//     allowAnyOrigin,            // test-harness escape hatch — never set in prod
//   }
// }

import { executeSteps, buildAllowedHosts, hostAllowed } from "./connector-steps.mjs";

// Read the named session material out of the browser after a successful login. Returns
// { cookies?: {name:value}, token?: string } — only what harvest asked for.
export async function harvestSession({ page, harvest }) {
  const out = {};
  if (Array.isArray(harvest?.cookies) && harvest.cookies.length) {
    const want = new Set(harvest.cookies.map((c) => String(c)));
    const all = await page.context().cookies();
    const found = {};
    for (const c of all) if (want.has(c.name)) found[c.name] = c.value;
    const missing = [...want].filter((n) => !(n in found));
    if (missing.length) throw new Error(`login did not set the expected cookie(s): ${missing.join(", ")} — the sign-in may not have completed`);
    out.cookies = found;
    return out;
  }
  if (harvest?.storageKey) {
    const key = String(harvest.storageKey);
    const token = await page.evaluate((k) => window.localStorage.getItem(k), key);
    if (token == null || token === "") throw new Error(`login left no token in localStorage["${key}"] — check the harvest key or the sign-in`);
    out.token = String(token);
    return out;
  }
  throw new Error("harvest declares neither cookies nor a storageKey");
}

export default async function run({ page, shot, input, log }) {
  const p = input?.params ?? {};
  const def = p.definition ?? {};
  const login = def?.login;
  const harvest = def?.harvest;
  if (!Array.isArray(login) || login.length === 0) return { ok: false, error: "browser-session connector has no auth.login steps" };
  if (!harvest || (typeof harvest !== "object")) return { ok: false, error: "browser-session connector has no auth.harvest" };

  const allowedHosts = buildAllowedHosts(def);
  const allowAny = p.allowAnyOrigin === true;
  const ctx = {
    user: p.user ?? {},
    payload: p.user ?? {},
    config: p.config ?? {},
    client: p.client ?? {},
    vars: {},
    def,
    secret: { username: input?.username ?? "", password: input?.password ?? "" },
  };

  const r = await executeSteps({ page, shot, log, steps: login, ctx, allowedHosts, allowAny, totpSeed: p.totpSeed, label: "login" });
  if (!r.ok) return { ok: false, error: r.error, evidence: r.evidence };

  // Harvest only from an allowlisted page — a login that ended on an unlisted host is a failed login.
  if (!hostAllowed(page.url(), allowedHosts, allowAny)) {
    const evidence = await shot("login-offhost");
    return { ok: false, error: `after login the page is on ${new URL(page.url()).host}, which is not in the connector's allowlist — refusing to harvest a session there`, evidence };
  }

  try {
    const session = await harvestSession({ page, harvest });
    // message/evidence are safe to surface; `session` carries secret material and is consumed by the
    // PowerShell side (redacted), never logged.
    return { ok: true, message: "signed in and harvested the session", session };
  } catch (e) {
    const evidence = await shot("login-harvest-fail");
    return { ok: false, error: `harvest failed: ${e?.message ?? e}`, evidence };
  }
}
