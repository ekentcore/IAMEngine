import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "case-requested-mail-forwarding",
  date: "2026-08-24",
  time: "16:00",
  title: "An offboard applies the mail forwarding the ticket asked for",
  items: [
    "A ticket could ask for the leaver's mail to be forwarded and nothing happened — no step, no error, no note. (FR #0000097, and #0000099 filed as the same defect)",
    "Both halves already existed and had simply never been joined: the intake has always captured \"mail forwarded\" and \"forward email to\", and the Exchange step has always known how to set forwarding. Nothing in between passed one to the other, so the runner's forwarding branch could not be reached from the app",
    "The forwarding target is now planned onto the Exchange step, with the sys_id the intake appends for display stripped off first — Exchange needs the address on its own",
    "It is applied ONLY when the ticket's \"mail forwarded\" box is ticked. A target address on its own is not a request, and two recent cases had one filled in alongside an explicit no",
    "A client that has configured \"keep a copy in the mailbox\" keeps that setting; the ticket supplies only the address",
    "No runner release needed — this was entirely a plan-time gap, the third of this exact shape after the out-of-office fix (#0000047) and mailbox delegates (#0000084)",
  ],
};
