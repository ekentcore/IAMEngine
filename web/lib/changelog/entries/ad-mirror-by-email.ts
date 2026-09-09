import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "ad-mirror-by-email",
  date: "2026-09-09",
  time: "14:00",
  title: "\"Mirror this user\" works when the ticket names them by email address",
  items: [
    "The Active Directory group mirroring looked the reference user up by display name, account name or full name only — so a ticket that named them the way tickets almost always do, by email address, matched nothing and the step reported \"mirror user … not found — mirror groups not applied\". (FR #0000126)",
    "Almost always is not a figure of speech here: 36 of the last 40 mirror requests gave an address. Nine of those reached the AD lane and every one of them missed",
    "It now tries the address forms too — sign-in name first, then the mailbox address — and still tries the name forms, so a ticket that gives a plain \"Christine Holleran\" behaves exactly as before. Whichever shape the value is, the other shape is tried as a fallback",
    "A user whose email address and sign-in name have drifted apart, which happens after a domain change, resolves on either one",
    "The Microsoft 365 side of the same field was never affected — it has always handled an address. That is the tell in the reports: the same case would mirror cloud groups correctly and report the AD groups as un-mirrorable in the same breath",
    "Runner 1.118.0 (active-directory module) needs deploy",
  ],
};
