import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "google-delinea-field-names-match-template",
  date: "2026-07-21",
  time: "10:00",
  title: "Google setup guide now names the real Automation - API fields - a manual secret is actually creatable",
  items: [
    "The /help/google 'Store it in Delinea' section told you to fill a ServiceAccountKeyBase64 field - but Secret Server fields are fixed per template, and the Automation - API template has no such field, so the manual path was un-followable as written",
    "The guide now documents the template's four real fields and what goes in each: ClientSecret = base64 of the JSON key, accountid = the service account's email, apiURL = the super-admin to impersonate (an email, repurposed on purpose), ClientID = the Workspace customer id (optional, my_customer default)",
    "A manually created secret now comes out identical to what the auto-setup vaults, so the Test button and the runner exercise the same shape either way",
    "The runner's 'no service-account key' and 'no admin to impersonate' errors now name the Automation - API fields first (ClientSecret / apiURL) instead of custom-template field names that don't exist on the fleet's stock template - runner 1.79.4",
    "Custom templates keep working unchanged: ServiceAccountKeyBase64 / ServiceAccountJson / ClientEmail+PrivateKey / Impersonate are still matched leniently, now documented as the alternative rather than the default",
  ],
};
