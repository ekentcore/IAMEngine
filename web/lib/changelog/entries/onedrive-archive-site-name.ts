import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "onedrive-archive-site-name",
  date: "2026-07-24",
  time: "18:15",
  title: "OneDrive-to-SharePoint archive accepts a site NAME, and stops blaming the wrong permission",
  items: [
    "The archive target only accepted a user email or a SharePoint site URL; Six One's profile stores the prose name 'Offboarded User Data SharePoint site', so every archive threw 'unrecognized OneDrive archive target'",
    "A bare target is now treated as the site's display name: the prose 'SharePoint site' suffix is stripped and the name resolved via Graph site search - an exact name match wins, a single hit is accepted, and zero or several candidates refuse with the shortlist rather than guess where the leaver's data lands (app-only site search needs the Sites.Read.All role, and the message says so)",
    "The failure hint is honest now: '(needs the Files.ReadWrite.All app role?)' was appended to EVERY archive failure, including plain config errors - it now appears only when Graph really answers 403",
    "The case preview notes that the drive placeholders are resolved at run time, so '<leaver's drive>' stops reading as a broken template substitution",
    "Runner 1.103.0 - next deploy",
  ],
};
