import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "google-oauth-dehead-ua",
  date: "2026-07-21",
  time: "08:45",
  title: "Runner browser flows: de-headless the User-Agent so Google issues a live OAuth token",
  items: [
    "THE SYMPTOM: after the offline-grant fix, the Google Workspace setup got a token — but every provisioning call to the Google Cloud APIs failed with 401 'invalid authentication credentials'.",
    "THE CAUSE: Playwright's Chromium reports 'HeadlessChrome' in its User-Agent. Google's OAuth token endpoint treats that as an automation signal: the sign-in still succeeds and returns an authorization code, but the code redeems for an access token with expires_in:0 — dead on arrival, so every API call 401s. Proven live on Drive Capital: identical flow, a 'HeadlessChrome' UA gave expires_in 0; the same UA with that one token swapped to 'Chrome' gave expires_in 3599. Chromium's newer --headless=new does NOT help — its UA still says HeadlessChrome.",
    "THE FIX: the shared browser launcher now reads Chromium's own User-Agent and swaps only the 'HeadlessChrome' token for 'Chrome', keeping the real platform and version correct on any runner OS. navigator.webdriver is scrubbed as a second automation tell. This applies to every browser flow — a normal-looking UA can only help other portals (e.g. Microsoft SSO), never hurt.",
    "Ships in runner 1.79.2 — runners self-update on their next heartbeat once the app serves it.",
  ],
};
