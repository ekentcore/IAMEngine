import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "mailbox-not-converted-decision",
  date: "2026-07-16",
  time: "15:30",
  title: "Offboards that parked on \"the mailbox was NOT converted to shared\" now have buttons that finish them",
  items: [
    "That warning used to be a dead end. It said \"convert the mailbox, then re-run this step\" — but for a client whose profile configures no conversion at all, nothing in the case ever converts anything, so every re-run reproduced the identical warning and the seat was never reclaimed. UM0029840 (Easterseals) sat on it with a 2.74 GB mailbox: nowhere near the 50 GB cap, so size was never the obstacle",
    "The step now ASKS, with the three answers that actually resolve it: convert the mailbox and remove the licence; remove the licence anyway (the mailbox is deleted when its 30-day grace expires); or leave both alone on purpose. The destructive one has to be confirmed",
    "Whichever you pick, once it has run the step is a SUCCESS — not a permanent warning. A warning now means one thing only: a human still has to answer something. What happened is still stated in full, still audited, still in the ServiceNow work note — a destroyed mailbox is recorded loudly, it just isn't recorded as an open question",
    "Same rule applied to the outcomes that already existed: an over-the-cap mailbox you answered \"remove\", and a client configured with removeLicense.allowWithoutConvert, both used to leave a WARN and so parked their case at the \"warning\" verdict permanently with nothing left for anyone to do. Both are answered questions — one by you on the case, one standingly by the client — so both now finish green. Only the unanswered ask still warns",
    "Convert works by re-queuing the Exchange step with convert-to-shared and letting the licence step follow it. That ordering is the whole trick: entra already depends on exchange, so putting exchange back to pending FIRST makes the dependency gate hold the licence step until the mailbox is actually shared. Re-queued the other way round, a runner claims the licence step against the stale result and just asks again",
    "Converting is only offered when it can work. Exchange refuses to convert a mailbox whose size it couldn't read (it can't prove it's under the cap), so on an unreadable size the button is withheld and says why, rather than being a button guaranteed to fail",
    "After a one-off convert, the case offers to make convert-to-shared that client's default so the next offboard doesn't stop on the same warning. It's a separate, explicit click — clearing a case should never quietly change how every future offboard for that client behaves — and it needs the client-systems permission, not just case dispatch",
    "It does NOT reuse the over-the-cap decision's wording, which hardcodes \"over the N GB cap\". On a 2.74 GB mailbox that sentence is simply false, and it would have gone into an AuditLog row and a ServiceNow work note as a falsehood",
    "Fixed alongside: the over-the-cap picker never checked whether its re-run actually started. A refusal there showed a successful-looking UI with nothing queued — the answer saved, the case untouched, and no one told",
  ],
};
