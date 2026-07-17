import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "offboard-onedrive-delegate-access",
  date: "2026-07-16",
  time: "22:15",
  title: "Offboarding grants the delegate the leaver's OneDrive too",
  items: [
    "There was no OneDrive handling at all — a ticket asking for \"access to Matt's inbox and OneDrive for Peter\" got the inbox handled (now, per FR #7) and the OneDrive silently ignored. (FR #0000008)",
    "The case-named delegate is now granted access to the leaver's whole OneDrive on the m365/entra offboard step: the name resolves to a user at run time, the grant is idempotent, and the run report shows the OneDrive URL.",
    "Fail-soft by design: no OneDrive provisioned, an unresolvable name, or a missing Graph permission (Files.ReadWrite.All) is a loud warning that names the fix — never a failed offboard.",
    "Opt out per client with oneDriveDelegateAccess: false on the m365 offboard config. Runner 1.69.0.",
  ],
};
