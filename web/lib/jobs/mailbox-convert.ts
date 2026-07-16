// The two facts the M365/entra licence gate is handed at claim time: has the mailbox actually been
// converted to a shared mailbox, and is a conversion still coming?
//
// Both are pure decisions over an Exchange job's result, extracted so they can be tested without a
// database — and because getting either wrong costs real money or real mail:
//   - too permissive on `converted`  -> the licence comes off a mailbox that is still a UserMailbox,
//                                       and Exchange purges it after the 30-day grace (mail lost)
//   - too permissive on `pending`    -> the step waits forever for a convert that will never run,
//                                       and the seat is billed indefinitely (money lost)
import type { JobStatus } from "@prisma/client";

// A conversion the runner has CONFIRMED. The Exchange executor has three success shapes, and one
// trap:
//   "converted mailbox to shared"                cloud-mastered (Set-Mailbox) — effective immediately
//   "… on-prem … verified shared in the cloud"   hybrid (Set-RemoteMailbox) — read back as shared
//   "… on-prem … no cloud mailbox to purge"      MailUser — the mail lives on-prem; nothing to purge
//   "already a shared mailbox"                   nothing to do
//
// The trap: the hybrid line CONTAINS the bare cloud line as a substring ("converted mailbox to shared
// on-prem (Set-RemoteMailbox -Type Shared)"). A loose match therefore read an *unsynced* on-prem
// convert as done — the on-prem attribute is set but the CLOUD mailbox stays a UserMailbox until an
// Entra Connect delta cycle lands, and stays one forever if the sync trigger failed. So the bare
// phrase must not match when "on-prem" follows it; the hybrid path has to earn it with an explicit
// cloud read-back.
//
// Anything unrecognised is "not converted", which keeps the licence. That is the safe default, and it
// is also what makes results written by an OLDER runner (which emitted the bare on-prem line with no
// read-back) fall back to keeping the licence rather than acting on an unverified convert.
const CONVERT_CONFIRMED =
  /converted mailbox to shared(?!\s+on-prem)|verified shared in the cloud|no cloud mailbox to purge|already a shared mailbox/i;

export function isConvertConfirmed(actionLines: string[]): boolean {
  return actionLines.some((a) => CONVERT_CONFIRMED.test(a));
}

// Statuses where the Exchange step may still convert the mailbox: in flight, or on a human's
// checklist. `succeeded` means it is done (and `isConvertConfirmed` says what it decided);
// `failed`/`skipped` mean it is never going to run — when a case fails, every remaining job is marked
// skipped. Treating those as "pending" told the operator to "re-run this step once the mailbox step is
// done", describing a state that can never arrive: they re-run, get the identical warning, and the
// seat bills forever. They fall through to the "mailbox was NOT converted" branch instead, which names
// the real problem and the real fix.
const CONVERT_STILL_COMING: ReadonlySet<JobStatus> = new Set<JobStatus>(["pending", "dispatched", "running", "manual"]);

export function isConvertStillComing(exchangeStatus: JobStatus, convertToSharedConfigured: boolean): boolean {
  return convertToSharedConfigured && CONVERT_STILL_COMING.has(exchangeStatus);
}
