import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "offboard-onedrive-archive",
  date: "2026-07-16",
  time: "22:15",
  title: "Offboarding can move the leaver's OneDrive files to another OneDrive or SharePoint",
  items: [
    'The profile\'s oneDriveBackup setting only printed "OneDrive backup required" and a human did the rest. It now actually archives: every top-level item is copied server-side into an "Archive - <name>" folder on the target. (FR #0000009)',
    "The target is the existing oneDriveBackup.target — a user's email (their OneDrive) or a SharePoint site URL (its document library).",
    "Copies run to completion on Microsoft's side once initiated, so a big drive doesn't block the case. The source is left intact — it disappears with the account, which is what makes a re-run safe: already-copied items are recognized and counted, not duplicated and not errors.",
    "The plan preview shows the archive before anything runs. Runner 1.69.0.",
  ],
};
