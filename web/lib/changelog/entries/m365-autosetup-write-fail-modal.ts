import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "m365-autosetup-write-fail-modal",
  date: "2026-07-20",
  time: "14:00",
  title: "M365 auto-setup: a Delinea write failure now pops a modal, not just a log line",
  items: [
    "When the auto-setup provisions the app registration but can't vault the credential, the failure used to live only in the expandable run log",
    "It now opens a modal that names the error, shows the app registration id, and explains the fix: re-run (rotates a fresh secret and re-attempts the vault write), or create the secret by hand in the Entra Azure AD Account template",
    "The app secret is issued once and is server-only, so the modal gives guidance + a Re-run button rather than a copyable value",
    "Fires on the structured signal (status failed at the 'write' stage), once per run",
  ],
};
