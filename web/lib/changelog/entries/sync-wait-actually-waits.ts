import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "sync-wait-actually-waits",
  date: "2026-09-17",
  time: "16:00",
  title: "The directory-sync step waits for the sync again — the wait added in September had never run",
  items: [
    "The Entra Connect step was supposed to poll until the delta sync finished (shipped 2026-09-08). It never polled. The probe it used could not see the runner's own sync helpers, threw immediately, and the step treated that as \"could not read the scheduler ... probably fine\" and reported success — so it was really: start the sync, wait ten seconds, claim done (FR #0000127)",
    "That is why a downstream step could still fail to find the new account, and why re-running the sync step appeared to change nothing while running the command on the server by hand worked",
    "The unit tests could not catch it: they supplied their own probe, so the polling was tested and the wiring into it never was. There is now a test that drives the real step and checks the scheduler was actually read",
    "Success wording no longer claims more than the step checked. A finished sync cycle means a cycle ran — not that this particular user was included: their account may sit outside the sync scope, or be filtered by a sync rule, and the cycle finishes cleanly either way",
    "The read-back likewise. It confirms the sync mechanism is healthy, which is all an on-prem step can see without a cloud credential, and now says so instead of reading as \"this user reached Entra\"",
    "A sync already running when the step arrives no longer promises to carry the change — if that cycle started before the case's AD edits, they go up on the following one",
    "An unreadable scheduler is now a warning rather than a reassurance",
    "Deploy runner 1.128.0",
    "Still true: nothing in this step verifies the user reached Entra. It has no cloud credential and cannot. What changed is that it no longer implies otherwise — real verification needs a design pass",
  ],
};
