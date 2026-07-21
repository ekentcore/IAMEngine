import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "google-key-tool-create-delinea",
  date: "2026-07-21",
  time: "11:45",
  title: "Google key tool can create the Delinea secret and wire it to a client",
  items: [
    "The /tools/google-key page now has editable apiURL (the super-admin email the service account impersonates) and ClientID (customer id) boxes, next to the ClientSecret + accountid it reads from the key file",
    "A new Create Delinea entry button picks a client from a searchable list (by name or CoreID), creates the google-admin secret on the Automation - API template straight into that client's Delinea folder, validates it against Google, and saves the returned Delinea id onto the client",
    "If the client already has a google-admin credential, it asks to overwrite it in place (same Delinea id) or create a distinct new one and re-point the client. The overwrite is guarded server-side so it can only touch the id already wired on that client",
  ],
};
