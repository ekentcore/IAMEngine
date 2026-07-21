import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "google-key-converter-tool",
  date: "2026-07-21",
  time: "10:45",
  title: "New More → Tools → Google key converter: drop in a JSON key, copy out the Delinea fields",
  items: [
    "A standalone page at /tools/google-key (under a new More → Tools menu group) converts a downloaded Google service-account JSON key into the exact google-admin secret fields, with no terminal and nothing uploaded - the file is read entirely in your browser",
    "Upload the .json key and it hands you ClientSecret (base64 of the file, masked with a reveal toggle) and accountid (the service account email), each with a copy button; it reminds you apiURL is the super-admin email you supply and ClientID (customer id) is optional",
    "Built for operators on locked-down Windows machines who can't run the base64 command and couldn't find the in-form upload - this is the same conversion, reachable from the top nav instead of buried in a client's guided setup",
    "Reuses the exact parser the guided create form uses (lib/secrets/field-seeders.ts), so a wrong file (not JSON, an OAuth-client download, a key missing client_email/private_key) is rejected with the same plain-language message",
    "Copy buttons use the shared clipboard helper, so they work (and tell the truth) even when the app is served over plain HTTP on the LAN",
    "/help/google links to it from the manual-setup section",
  ],
};
