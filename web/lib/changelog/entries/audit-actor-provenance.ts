import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "audit-actor-provenance",
  date: "2026-07-15",
  time: "10:00",
  title: "The audit log can now tell you who did it - before, half of it just said 'ui'",
  items: [
    "Nobody could answer 'who created this case?'. Cases carried no creator at all - the only trace was the case.plan audit row written in the same second, and you had to know to go looking for it. Cases now record who opened them and how (by hand, imported from ServiceNow, pulled in by the poller, or the simulator), as columns on the case itself",
    "The existing 21 cases were backfilled from their audit history, so the answer is there for cases that already exist - not just new ones",
    "Editing a runbook was audited as 'ui' - no name. Every runbook, systems, secrets, rules and client edit now names the engineer who made it. Same for approving a destructive step, revealing a password, and re-running a job, all of which recorded the action but not the person",
    "A runbook save now records WHAT changed, not just that it was saved: the sections and steps added, removed, renamed and reordered. A save is a delete-and-recreate, so a section that quietly disappears is how a client stops getting a system provisioned - and until now the log could only say 'someone re-saved the runbook'",
    "Deleting an agent, re-scoping one to a different client, changing runner priority, and issuing an enrolment token were not audited at all. They are now",
    "The case list says 'Created by' for a hand-keyed case instead of mislabelling it 'Imported'",
  ],
};
