import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "offboard-already-shared-mailbox",
  date: "2026-07-24",
  time: "13:30",
  title: "Offboarding: a mailbox that's already shared now unblocks the licence step, instead of parking the case",
  items: [
    "The Exchange offboard step only reported a mailbox as converted when IT did the converting. If the mailbox was already a shared mailbox — converted by a previous run, or by hand — the step said nothing, and the licence step (which only proceeds once it sees a 'converted' signal) kept the licence and parked the case with 'license KEPT' for no reason: the mailbox was already safe.",
    "The Exchange offboard step now checks the cloud mailbox's current state independent of whether convertToShared is even configured on the case. If it's already a shared mailbox, it says so plainly — 'already a shared mailbox - no conversion needed; the licence is safe to remove' — and the licence step (which already recognized that exact phrase) proceeds automatically.",
    "When convertToShared IS configured and the mailbox is already shared, the redundant Set-Mailbox / Set-RemoteMailbox conversion call is skipped — there is nothing left to convert.",
  ],
};
