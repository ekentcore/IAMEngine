import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "change-exchange-lane",
  date: "2026-07-18",
  time: "18:45",
  title: "Change/mover: Exchange change executor",
  items: [
    "New Exchange change executor: add/remove distribution lists & M365 groups by name (resolved live, DL vs 365-group told apart by RecipientTypeDetails) and grant/revoke shared-mailbox FullAccess",
    "Removal/revoke follows the same audit-integrity pattern as the AD & M365 change lanes: a real EXO failure logs a WARN, a not-found name is a benign skip, never a false 'removed' line",
  ],
};
