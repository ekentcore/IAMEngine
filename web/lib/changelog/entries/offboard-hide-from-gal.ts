import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "offboard-hide-from-gal",
  date: "2026-07-21",
  time: "12:45",
  title: "Offboards now hide the leaver from the address book by default",
  items: [
    "Every offboarding now hides the departing user from the Global Address List (Exchange/365) and from directory/contact sharing (Google) automatically — previously only clients with an on-prem AD attribute configured got this (FR #0000021)",
    "A client can opt out by setting hideFromGal: false on their exchange or google offboard config; a single offboard can keep the person listed with the new 'Keep in global address list' checkbox on the case form",
    "Directory-synced mailboxes can't be hidden from Exchange Online directly — if a client has selected an AD hide attribute (e.g. msExchHideFromAddressLists) it's used; otherwise the step WARNs a human instead of failing the offboard",
    "The change is idempotent: a mailbox that's already hidden is left alone, and every hide is read back before it's reported done",
  ],
};
