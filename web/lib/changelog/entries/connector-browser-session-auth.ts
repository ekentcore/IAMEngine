import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "connector-browser-session-auth",
  date: "2026-07-17",
  time: "14:00",
  title: "Connectors can authenticate an http API by a browser login (the hybrid session connector)",
  items: [
    "A connector can now use auth type browser-session: a headless browser performs the portal login (username/password, optional TOTP), the resulting session is harvested (a named cookie set, or a token from localStorage), and the connector's ordinary http operations then run with it - for the many portals whose API is real but authenticated by a browser session rather than a static key (exactly the case the HAR-import credential probe flags as 'auth-rejected / redirected to login')",
    "The runner signs in once per job (the session is cached per secret and reset per job, so it never leaks between clients on the fleet-wide runner), harvests only after login succeeds and only on an allowlisted page, and registers the harvested values for redaction before use",
    "A browser-session connector needs the browser capability and joins the browser-gated claim set like a browser connector - an http connector is no longer proof that no browser is needed (connectorNeedsBrowser decides); its connection test doesn't fire a standalone login on the sweep",
    "The login steps use the same declarative browser-step vocabulary as browser connectors and are held to the same validation (host allowlist on login navigation, exactly-one target, secret redaction); apply modes are cookie (send the cookie set), bearer, or a custom header",
    "Runner 1.72.0 (needs deploy). Verified end-to-end against a real headless Chromium: login harvests a cookie and a localStorage token, refuses to type the credential on an off-allowlist page, and the offboard lane runs the http op with the harvested cookie",
  ],
};
