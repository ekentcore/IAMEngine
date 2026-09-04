import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "case-requested-shared-mailboxes",
  date: "2026-09-04",
  time: "12:00",
  title: "Shared mailboxes named on the ticket are actually granted",
  items: [
    "A ticket could ask for the new user to have access to specific shared mailboxes and nothing happened — no step, no error, no note. (FR #0000115)",
    "Both halves already existed and had never been joined: the intake has always captured the requested mailboxes, and the Exchange step has always known how to grant access to a named list. Nothing in between passed one to the other, which is exactly why the per-client default mailboxes worked while ticket-requested ones did not — the client list is configuration, and the ticket had no route to the same place",
    "Requested mailboxes are now added to that same list, at Full Access, and the two are combined rather than one replacing the other: the client's standing mailboxes and the ticket's request are both wanted",
    "A mailbox the client already grants is not added a second time, and blanks and repeats on the ticket are dropped before anything is planned",
    "This is the fourth field of this shape to be joined up, after the out-of-office message (#0000047), mailbox delegates (#0000084) and mail forwarding (#0000097)",
    "Web-only — no runner change",
  ],
};
