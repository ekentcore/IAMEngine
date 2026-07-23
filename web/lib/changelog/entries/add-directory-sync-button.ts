import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "add-directory-sync-button",
  date: "2026-07-22",
  time: "17:00",
  title: "Add directory-sync to a hybrid client in one click from its warning box",
  items: [
    "A hybrid client (on-prem Active Directory + a cloud identity system) with no directory-sync step showed a warning telling you to go add it by hand in Edit systems - now the warning has an Add directory-sync button",
    "The button opens a prefilled confirm dialog: it drops in the canonical directory-sync system (api mode, runs on onboard and offboard, uses the optional ad-dc secret so no credential wiring is needed)",
    "'Order after' defaults to exchange with wait-for-mailbox when the client has Exchange, otherwise active-directory; a checkbox (on by default) also flips the client's backbone to ad-synced",
    "Confirming re-reads the client's current systems and saves the whole set back, so every existing system is preserved; adding is idempotent if a directory-sync row already exists",
  ],
};
