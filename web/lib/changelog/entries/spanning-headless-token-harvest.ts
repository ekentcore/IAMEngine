import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "spanning-headless-token-harvest",
  date: "2026-07-22",
  time: "12:45",
  title: "Spanning auto-setup: headless login + harvest the API token via the console API",
  items: [
    "Spanning's \"Automatic (browser)\" setup now does a real HEADLESS Microsoft-365 SSO sign-in and harvests the API token via the console's OWN same-origin API (GET/POST /api/apiUser/token) — no more fragile Settings-UI clicking",
    "Reuses an existing token when one is present (never regenerates — that would invalidate the live key everywhere); creates one only when none exists; and if the console withholds an existing token's value, stops with a clear \"paste it or explicitly regenerate\" message rather than clobbering the key",
    "Signs into the correct REGIONAL console host (https://<service>-<region>.spanningbackup.com) derived from the client's service + region; the harvested login email (the API's msUserPrincipalName) is preferred when vaulting the `spanning` credential",
    "Runner 1.88.0 — needs deploy. The token rides the runner's session channel and is scrubbed from the job result after vaulting; it is never logged",
  ],
};
