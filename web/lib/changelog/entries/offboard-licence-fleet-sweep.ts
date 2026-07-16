import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "offboard-licence-fleet-sweep",
  date: "2026-07-14",
  time: "17:45",
  title: "We were not reclaiming the leaver's licence for 128 of 134 clients - and the one rule that stops us destroying their mailbox was dead code",
  items: [
    "BayPine's missing 'remove the licence' step turned out not to be a BayPine problem. Of 134 clients with a 365 offboard, only SIX removed the leaver's licence or converted their mailbox - while 203 of 230 runbooks say to remove it. The profile generator produced the STEPS but never the CONFIG, and licence removal is opt-in, so for ~128 clients we blocked sign-in and then quietly left a paid, licensed mailbox behind. Nothing failed. Nothing warned",
    "114 clients are now configured from what their runbook actually says: block sign-in and strip groups (365) -> convert the mailbox to shared (Exchange) -> remove the licence (Entra), with the licence step DEPENDING on the mailbox step so it cannot run first",
    "Order is not a detail here. Taking the licence off a mailbox that is not yet shared destroys it - Exchange purges an unlicensed, unconverted mailbox once the 30-day grace expires. Most of the six configured clients (Regal, Six One, Yuma) had exactly that ordering, and had been getting away with it inside the grace window",
    "The safety rule that should have caught this was dead. The 365 module keeps the licence when a mailbox is too big to become shared - but the runner never passed it the mailbox size, so it always read 0 and could never fire. Exchange knew the size all along and had nobody to tell",
    "Now, if the mailbox cannot be converted - too big, or the conversion has not run yet - the licence is KEPT and the step raises a warning for an engineer to pick up, rather than silently doing the destructive thing. That holds even if a client's ordering is wrong, so a mis-configured profile is now safe instead of dangerous",
    "Clients whose runbook FORBIDS removing the licence were not automated - a regex cannot tell 'remove the licence' from 'do NOT remove the licence', so those were read by hand. Carrington Coleman ('NOTE: Do NOT remove the license') keeps its licence, and ACORE ('do not remove the license yet') has it removed in the later step, after the mailbox",
    "Carrington Coleman now gets a MANUAL checklist item on every offboard that says the licence was left in place on purpose, and quotes the runbook line. Without it, 'we deliberately left the licence' and 'the engine silently failed to remove the licence' look identical on a case - and the second one is the bug this whole batch exists to kill. Manual steps also now show their instruction note on the run report instead of rendering as an empty line",
    "Yuma had a circular dependency (Exchange waited on Entra while Entra waited on Exchange) that would have deadlocked its offboard. Fixed, and the sweep now refuses to create one",
  ],
};
