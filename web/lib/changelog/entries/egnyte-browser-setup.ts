import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "egnyte-browser-setup",
  date: "2026-07-22",
  time: "07:45",
  title: "Egnyte API credential: automatic browser setup",
  items: [
    "The Egnyte guided setup gains an “Automatic (browser)” option: the runner signs into the client's Egnyte admin console, harvests a domain API token, and vaults the `egnyte` credential (domain + token) to the client's Vendor subfolder in Delinea — no manual copy/paste",
    "The vaulted secret is wired onto the client and recorded in setup provenance (which Delinea secret set it up, for later permission changes); the raw token is scrubbed from the job result as soon as it's vaulted",
    "Shows only for clients that have the Egnyte system; the paste-a-token path still works unchanged",
    "Runner 1.86.0 — needs deploy. The browser selectors are best-effort and NEED LIVE VALIDATION against a real Egnyte console; an SSO-only Egnyte account must paste the token instead",
  ],
};
