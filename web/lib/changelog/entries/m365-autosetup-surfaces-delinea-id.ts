import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "m365-autosetup-surfaces-delinea-id",
  date: "2026-07-20",
  time: "14:15",
  title: "M365 auto-setup now records which Delinea secret it vaulted (audit + run log)",
  items: [
    "The credential was already wired onto the client, but nothing told you WHICH Delinea secret id it was, so there was no way to find the entry and test it",
    "The setup result now carries the Delinea secret id (externalId); it's added to the m365.setup.client audit detail and to the run-log line ('wrote new credentials to Delinea (secret <id>)')",
    "The kept-existing path also reports the already-vaulted id, so a no-op run still names the credential",
    "The id is a reference, never a secret value",
  ],
};
