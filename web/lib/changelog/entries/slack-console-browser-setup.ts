import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "slack-console-browser-setup",
  date: "2026-07-22",
  time: "07:45",
  title: "Slack: guided credential setup with a best-effort browser sign-in",
  items: [
    "The guided setup for Slack now has an “Automatic (browser)” option that signs into the Slack console and attempts to harvest a SCIM token, vaulting it to the client's Delinea Vendor subfolder with setup provenance",
    "Because a Slack SCIM token comes from an app install with the admin scope (not a console field), the browser harvest is best-effort — when nothing is harvestable it says so and you paste the token via the guided form, which stays the reliable path",
    "Runner 1.85.0 — needs deploy. The Slack sign-in + console selectors are best-effort and NEED LIVE VALIDATION; SSO / email-magic-link workspaces can't use the browser login and should paste the token",
  ],
};
