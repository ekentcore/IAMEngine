import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "baypine-run-fixes-adopt-retry-archive",
  date: "2026-07-14",
  time: "16:45",
  title: "A rehire's account was left disabled, every Spanning offboard left a billable seat, and a self-healing step was crying wolf every 15 minutes",
  items: [
    "Onboarding a REHIRE could finish 'completed' with an account that cannot sign in. When an existing same-name account is adopted, we stamped our marker and moved on - but only the CREATE path ever switched the account on, and a rehire's old account is disabled. The validation read-back said 'AccountEnabled: false' on every run and nothing ever acted on it. Adopting now enables the account (and a re-run is a no-op if it already is)",
    "Every Spanning offboard has been leaving the leaver on a billable, still-backing-up Standard seat - fleet-wide, silently. Kaseya's API cannot CONVERT a Standard licence to an Archive one, so the 'swap to Archive' call was a no-op, and the vendor said so (licensed=false) while we logged a reassuring 'the read-back will confirm it' and reported success. The step now re-reads the tier and, if it is still Standard, says so as a WARNING with the exact manual fix (Spanning console -> Manage Licenses -> Activate Archived). It deliberately does NOT force the swap by unassigning first: Kaseya warns that can delete the backups, and retention is the entire point of the step",
    "A step waiting on a vendor sync no longer reports as a failure. Spanning and Mimecast discover a new 365 user on their own schedule, so the executors say 'not yet, ask me again in 15 minutes' - and the app was logging every one of those as a run-log warning AND firing a chat alert, every 15 minutes, for a step that fixes itself. It now shows as 'retrying' and stays quiet until it either lands or gives up",
    "...and it can now actually give up. The 16-attempt cap was dead code: re-queueing a job deleted its attempt counter, so the count reset to 1 every time and 'attempts < 16' was true forever. A user the vendor will NEVER discover (an unlicensed 365 user has no mailbox, so Spanning and Mimecast cannot see them) retried every 15 minutes indefinitely. The count now survives the re-queue; after ~4 hours the wait ends and raises a real warning",
    "Mimecast now rides out a gateway blip. A single HTTP 504 ('Connection to service has timed out') failed a whole onboard - only 401 was ever retried. 429/502/503/504 now back off and retry (500 does not: it can mean the request was processed and then blew up). The same 502/504 gap is closed in the 365 write path",
    "When Graph refuses to read a leaver's MFA methods, the warning now names the permission to grant (UserAuthenticationMethod.ReadWrite.All). It was only matching one of Graph's two ways of saying 'denied', so the other one produced a vague 'could not read MFA methods' with no way forward",
  ],
};
