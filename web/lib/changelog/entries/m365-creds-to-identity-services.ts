import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "m365-creds-to-identity-services",
  date: "2026-07-20",
  time: "15:00",
  title: "M365 auto-setup vaults the credential in the client's Identity Services subfolder",
  items: [
    "The app-registration credential was created in the client's ROOT Delinea folder, whose permissions are narrow — so the vaulted secret read as 'not viewable'",
    "It now creates the secret in the client's 'Identity Services' subfolder (which carries the identity team's view permissions); the secret inherits folder permissions, so it's viewable by the right people",
    "Falls back to the client folder when there's no such subfolder; the subfolder name is overridable via DELINEA_IDENTITY_SUBFOLDER",
    "New findChildFolderByName helper resolves the subfolder id under the client folder",
  ],
};
