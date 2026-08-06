import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "offboard-case-out-of-office",
  date: "2026-08-06",
  time: "17:45",
  title: "Offboarding sets the out-of-office message the ticket actually asked for",
  items: [
    "The offboard form captures the leaver's out-of-office text and nothing ever read it. The intake mapper wrote it onto the case as oooMessage and there was no consumer anywhere — so a requestor who filled the field in got silence, and the mailbox answered nothing. (FR #0000047)",
    "The message now flows onto the Exchange step and is set as the mailbox auto-reply, internal and external",
    "No runner release needed: the Exchange executor has always implemented the destination (config.autoReply.message). The entire gap was plan-time — the field was captured on one side and read on neither",
    "Exchange only, because it is the sole lane that can set a mailbox auto-reply. The AD and Graph steps never carry it",
    "The ticket's text overrides a client's profile-configured default — what the ticket asks for beats a standing default — while a blank or absent message leaves the profile's own auto-reply exactly as it was, so a client with a standard leaver message keeps it",
    "It shows in the dry-run plan preview before anything runs, which the preview already knew how to render",
  ],
};
