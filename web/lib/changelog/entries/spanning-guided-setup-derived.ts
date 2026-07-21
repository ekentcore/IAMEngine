import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "spanning-guided-setup-derived",
  date: "2026-07-21",
  time: "09:00",
  title: "Spanning guided setup derives the API URL and account id",
  items: [
    "Setup Spanning API now collects what you actually have - the email you sign in to Spanning with and the API Key from Settings → API Token - plus two pickers: email service (o365, or google for a Google Workspace tenant) and region (default us)",
    "The rest is computed: the API URL as https://<service>-api-<region>.spanningbackup.com and the account id as the login domain without its suffix (admin@acme.com → acme), all vaulted on the Automation - API template (clientID / ClientSecret / accountid / apiURL)",
    "The pre-vault live test now normalizes a host-only apiURL the same way the runner does (append /external, force https) - previously a correct credential stored as just the host would have failed the probe with a 404",
  ],
};
