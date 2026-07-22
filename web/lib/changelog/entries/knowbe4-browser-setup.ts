import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "knowbe4-browser-setup",
  date: "2026-07-22",
  time: "08:00",
  title: "KnowBe4: automatic (browser) setup of the SCIM API token",
  items: [
    "The guided KnowBe4 setup gains an “Automatic (browser)” path: the runner signs into the KnowBe4 console with a wired knowbe4-console admin login, enables SCIM provisioning, harvests the bearer token, and the app vaults it to the client’s Delinea “Vendor” subfolder — recording which credential set it up (provenance)",
    "The harvested token is written once to Delinea and scrubbed from the job result immediately; it is never logged",
    "Runner 1.84.0 — needs deploy (version collides with sibling vendor-setup PRs; re-sequence on merge)",
    "NEEDS LIVE SELECTOR VALIDATION: the KnowBe4 sign-in + SCIM-settings DOM is unverified (no live console) — selectors are best-effort and each step logs its stage. A KnowBe4 tenant behind org SSO must paste the token instead",
  ],
};
