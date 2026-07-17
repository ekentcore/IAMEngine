import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "ten-fix-hardening-batch",
  date: "2026-07-17",
  time: "00:00",
  title: "Hardening batch: offboard safety, reseed protection, verify honesty (runner 1.71.0)",
  items: [
    "11 clients carried an unguarded licence removal with no Exchange step to protect the mailbox - their next offboard would have purged an unconverted mailbox with no warning. The config is stripped, and the sweep now refuses to write licence removal for any client without an exchange offboard step",
    "Approving a destructive offboard step now requires operator auth: with AUTH_ENABLED off, the approve endpoint (and AD hard-match) return 503 instead of accepting an anonymous approval with a made-up approver name",
    "A plain db:seed no longer silently reverts config that only lives in the database (the licence sweep's 67 clients, Edit-systems OUs, Delinea rewires, rules-editor edits, in-app runbooks) - differing rows are kept and reported; overwriting them needs an explicit --force",
    "'Verify everything' no longer flips a skipped step to verified-green, the green banner says when steps were skipped and never ran, and an interrupted verify pass rolls steps back to what they were instead of rewriting real successes into 'skipped'",
    "A case failure no longer cancels pending ad-hoc password resets, 'run this step only' requests, or a verify pass in flight",
    "An empty (0 GB) mailbox now shows the Convert button on the mailbox picker - 0 used to be treated as 'size unknown', which hid the safe answer for exactly the cheapest mailboxes to convert (runner 1.71.0; Exchange now reports 'not read' as null, never 0)",
    "Answering the mailbox picker the moment a case completes no longer errors - the answer converts the just-queued verify pass into the re-run it asked for",
    "'Run this step only' now accepts a failed dependency the operator already resolved, matching what the runner itself would do",
    "The 'waiting for X to finish first' line on pending steps now uses the runner's real claim gate, so a pending ad-hoc job can no longer show up as a blocker",
    "A licence removed off an unconverted mailbox (client opt-out or a picker answer) now sends a 'Mailbox purge scheduled' chat alert - the step stays green because the outcome was decided, but the 30-day purge clock starting is no longer knowable only by opening the case (new toggle under Settings > Notifications)",
  ],
};
