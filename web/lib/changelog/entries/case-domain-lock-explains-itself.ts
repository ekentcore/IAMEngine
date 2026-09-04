import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "case-domain-lock-explains-itself",
  date: "2026-09-04",
  time: "15:00",
  title: "The case email-domain picker says why it is locked, instead of just being greyed out",
  items: [
    "Picking a different email domain for a multi-domain client has been reported twice as impossible (FR #0000089, #0000111). The picker exists, works, and is in active use — it has been used on 13 cases across 6 clients, including one of the two cases the reports were filed from, four minutes after the report went in",
    "What was actually happening: the control greys out once any step has run, and it did so with only a tooltip to explain. A greyed control with no visible reason reads as a missing feature",
    "It now says so in the open — that steps have already run, and that the way to change the domain at that point is to trash the case and re-open it from the ticket",
    "The lock itself is unchanged and is deliberate: re-deriving the username after an account already exists would leave that account on the old address with nothing pointing at it",
    "Web-only — no runner change",
  ],
};
