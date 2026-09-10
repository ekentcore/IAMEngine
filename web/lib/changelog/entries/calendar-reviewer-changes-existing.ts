import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "calendar-reviewer-changes-existing",
  date: "2026-09-10",
  time: "17:00",
  title: "Calendar reviewer access is changed when the person already has some, instead of failing",
  items: [
    "Granting a client's standing calendar reviewer failed with \"An existing permission entry was found for user\" whenever that person already had ANY level of access to the calendar. (FR #0000135)",
    "The step did check first, but only for the exact right it was about to grant — the same right meant skip, no right at all meant grant, and anything else fell through to a cmdlet that refuses to touch an entry that exists. Adding a permission and changing one are different operations in Exchange, and only the first was being used",
    "The most common way to land in that gap is AvailabilityOnly, which plenty of mailboxes already carry before we touch them — so this was the ordinary case, not an edge one",
    "It now changes the existing entry to the right the client asked for, and says what it changed it from",
    "It also recovers if the check says there is no entry and Exchange then says there is — a permission read we were not allowed to make, or something added one in between. Re-running the step no longer fails on it either way",
    "A grant that fails for a real reason (the user does not exist, say) still warns rather than passing quietly",
    "Runner 1.119.0 (exchange module) needs deploy",
  ],
};
