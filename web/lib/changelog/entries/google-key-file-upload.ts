import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "google-key-file-upload",
  date: "2026-07-21",
  time: "10:15",
  title: "Upload the Google JSON key file - the browser does the base64 and fills the secret's fields",
  items: [
    "The google-admin secret needs the service-account key as base64, but the guide's only recipe was a terminal command - operators on a locked-down Windows machine had no way to run it",
    "The 'Create in Delinea' form (guided setup) now offers a file upload for google-admin: pick the downloaded .json key file and the browser converts it to base64 locally and fills ClientSecret + accountid - the file is never uploaded anywhere, and you type only apiURL (the super-admin email)",
    "The wrong file is caught at pick time with a plain-language message (not JSON at all, an OAuth-client download instead of a service-account key, or a key missing client_email/private_key) instead of a cryptic token-exchange failure at Test time",
    "Test & create still runs the live Google Directory probe on the seeded values before anything is written to Delinea, exactly as with typed fields",
    "/help/google now leads with the upload path and keeps the terminal recipe for hand-created secrets, now with a Windows PowerShell one-liner next to the macOS one",
    "Extensible: the upload is a per-secret 'field seeder' registry (lib/secrets/field-seeders.ts) - any credential that arrives as a downloadable file can plug in the same way",
  ],
};
