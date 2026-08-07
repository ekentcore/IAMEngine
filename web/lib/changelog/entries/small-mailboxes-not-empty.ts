import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "small-mailboxes-not-empty",
  date: "2026-08-07",
  time: "11:00",
  title: "Small mailboxes stop reading as empty, and an unreadable size no longer stalls an offboard",
  items: [
    "A mailbox with a little mail in it read as 0 GB — indistinguishable from an empty one. The size parser rounded to two decimal places, so everything under about 5 MB collapsed to exactly 0.00, and 0 is a MEANINGFUL reading everywhere downstream: \"known empty, the cheapest thing there is to convert\". It now keeps nine places, which resolves to the single byte. (FR #0000085)",
    "The old behaviour was pinned by a test asserting a 512 KB mailbox should be 0 — the bug had been written down as the expectation. That test now asserts the opposite",
    "Sizes are reported in a unit a human reads: \"512 KB\", \"33.5 MB\", \"75 GB\" — not \"0.000488 GB\", which is technically true and tells an operator nothing. A genuinely empty mailbox says \"0 (empty)\" and an unreadable one says \"unknown\", never a number",
    "POLICY CHANGE, requested explicitly: an unreadable mailbox size is now treated as 0 and the offboard converts and moves forward, where before it stopped and kept the licence. The size read is retried once first, because a failed read is usually transient EXO throttling",
    "The cost of that change, recorded plainly because it is real: a LARGE mailbox whose size read fails twice will now be converted to shared and stripped of its licence, and Microsoft caps an unlicensed shared mailbox at 50 GB — past that the mailbox is locked and its mail inaccessible. Every such assumption writes a loud warning naming that exact risk onto the case, the audit row and the ServiceNow work note, so a mailbox it damages can be traced straight back to it",
    "Runner 1.106.0 (Exchange module) needs deploy",
  ],
};
