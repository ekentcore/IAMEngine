import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "egnyte-api-password-grant",
  date: "2026-07-22",
  time: "13:30",
  title: "Egnyte API setup: correct the credential to Client ID + Secret + login",
  items: [
    "Fixed the Egnyte API setup instructions to match how Egnyte actually authenticates: the runner mints a bearer token via the Resource Owner Password grant from Client ID (the app Key), Client Secret, an admin login email (the OAuth username — the stock “Automation - API” template's `accountid` field), and that account's Password",
    "The guided-setup fields, the /help/egnyte guide, and the runner's field-picking now all describe those four fields; the Egnyte domain is optional and derived from the login email when left blank",
    "A pre-minted long-lived Token still works as an alternative to the four fields (what the browser auto-setup harvests) — a Token-only secret no longer false-flags as “missing fields” in Test",
    "Runner 1.88.0 — needs deploy: `Connect-CtgEgnyte` now sends `client_secret` (required for API keys issued after Jan 2015) and reads the login email from the `AccountID`/`Username` field",
  ],
};
