import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "offboard-license-after-shared-convert",
  date: "2026-07-14",
  time: "16:45",
  title: "BayPine was never removing the leaver's licence - and the rule meant to stop us destroying a mailbox was dead code",
  items: [
    "BayPine's runbook says 'remove the user's licence from their email'. It never happened. Their profile was generated with NO offboard config at all - just 'when: always' - and the executor only removes a licence when the config asks for it. Nothing failed and nothing warned; the work was simply never requested. The mailbox was never converted to a shared mailbox either, for the same reason",
    "BayPine now does: block sign-in and strip groups (365) -> convert the mailbox to shared (Exchange) -> remove the licence (Entra). The licence step is wired to depend on the mailbox step, so it CANNOT run before the conversion - the ordering is enforced by the plan, not by hoping the steps line up",
    "The safety rule that was supposed to prevent this was dead code fleet-wide. The 365 module keeps the licence when a mailbox is too big to become shared - but the runner never passed it the mailbox size, so it always read 0 and the rule could never fire. Exchange knew the size all along and had nobody to tell. It now hands it to the licence step, along with whether it actually converted",
    "Taking a licence off a mailbox that is NOT shared destroys it: Exchange purges an unlicensed, unconverted mailbox once the 30-day grace expires. The licence step now refuses to do that - it keeps the licence, says why on the run report, and tells you what to do instead",
    "And a profile that says 'do not remove the licence here, a later step does it' is now obeyed. MarketScience's profile has said exactly that for months and the code ignored it, stripping the licence in the very step the profile forbade",
  ],
};
