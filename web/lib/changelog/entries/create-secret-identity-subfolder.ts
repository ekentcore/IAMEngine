import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "create-secret-identity-subfolder",
  date: "2026-07-21",
  time: "14:30",
  title: "In-app 'Create in Delinea' now vaults into the client's Identity Services subfolder",
  items: [
    "Authoring a credential in-app (the setup wizard / guided API setup — used for Mimecast, Zoom, Adobe, Egnyte, and the like) created the secret in the client's ROOT Delinea folder, whose permissions are narrow — so the vaulted secret read as 'not viewable'",
    "It now creates the secret in the client's 'Identity Services' subfolder (which carries the identity team's view permissions), matching what the M365 and Google auto-setup writers already do; the secret inherits folder permissions, so the right people can see it",
    "Falls back to the client folder when there's no such subfolder; the subfolder name stays overridable via DELINEA_IDENTITY_SUBFOLDER. The client's stored folder id is still the ROOT (the subfolder is resolved at create time)",
    "The redirect is now a single shared resolveCreateFolderId helper used by the create route and both auto-setup writers, so the three paths can't drift",
  ],
};
