import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "requested-groups-reach-the-plan",
  date: "2026-07-16",
  time: "22:15",
  title: "Distribution lists and security groups picked on the ticket are now actually added",
  items: [
    "A requestor could add non-default email distribution lists to the case and the intake captured them — but nothing merged them into any job, so they were silently dropped and never added. (FR #0000004)",
    "Requested DLs now join the m365/entra step's groups and flow to the Exchange step (the only lane that can add DL members). A client with no Graph lane hands them to Exchange directly.",
    "Ticket-picked security groups join the directory that MASTERS them — AD when the client has an AD step (the membership syncs up), otherwise the Graph lane — so the other lane doesn't warn about a group it can't write.",
    "Everything is unioned case-insensitively with the client's rule-derived groups, so nothing default is lost and nothing is added twice.",
  ],
};
