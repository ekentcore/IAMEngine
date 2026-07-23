import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "fleet-m365-selfgrant-optional",
  date: "2026-07-22",
  time: "22:30",
  title: "Fleet setup — M365: self-grant now offered for optional-only gaps, not just missing required perms",
  items: [
    "The self-grant button (grant a client's missing Graph permissions using its own AppRoleAssignment.ReadWrite.All, no Global Admin) now appears whenever the app holds that role and is missing ANYTHING — a required OR an optional permission",
    "Before, a client whose required permissions were all covered but that was short some optional caps (e.g. Apollon, which holds the role and only lacks MailboxSettings.Read / Mail.Send / Device.ReadWrite.All / password-reset / OneDrive) showed no self-grant option — now it does, labelled 'Grant missing permissions'",
    "It's on Tools → Fleet setup — M365 on that client's row (the 'Extra access' audit tab is a read-only report of who holds the role); surplus roles are still only flagged, never removed",
  ],
};
