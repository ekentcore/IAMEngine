// What answering the mailbox_not_converted decision DOES — decided as pure data so the part that is
// easy to get wrong and invisible when wrong can be tested without a database.
//
// The order of `requeue` is the load-bearing bit. entra's request.dependsOn is ["m365","exchange"] and
// blockingJobs (jobs/runner-logic.ts) only holds a job whose api dependency is not
// succeeded/skipped/accepted. So while exchange still carries `succeeded` from its last run, a
// re-queued licence step is IMMEDIATELY claimable: a runner polling in that window re-runs it against
// the old exchange result (mailboxConverted still false) and simply asks the question again. Putting
// exchange back to `pending` FIRST is what closes the window — the licence step then lands behind a
// dependency that is no longer met. A caller that requeues this list out of order reintroduces the
// race silently, which is why the order is asserted in mailbox-decision.test.ts rather than left as a
// comment in a route handler.
export type MailboxPolicy = "convert" | "remove" | "keep";

export const MAILBOX_POLICIES: readonly MailboxPolicy[] = ["convert", "remove", "keep"];

export const isMailboxPolicy = (v: unknown): v is MailboxPolicy =>
  typeof v === "string" && (MAILBOX_POLICIES as readonly string[]).includes(v);

export type DecisionJob = { id: string; systemKey: string };
export type ConfigWrite = { jobIds: string[]; key: string; value: unknown };
export type DecisionPlan =
  | { ok: true; writes: ConfigWrite[]; requeue: string[] }
  | { ok: false; error: string; status: number };

// The M365 executor serves BOTH `m365` and `entra`, and on most clients the licence lives on the entra
// lane. Treating only one as "the licence step" is how an answer gets accepted, written to zero jobs,
// and silently lost — the mistake the m365-override route's comment records paying for once already.
const LICENCE_KEYS = ["m365", "entra"];

export function planMailboxDecision(policy: MailboxPolicy, jobs: DecisionJob[]): DecisionPlan {
  const licence = jobs.filter((j) => LICENCE_KEYS.includes(j.systemKey)).map((j) => j.id);
  const exchange = jobs.filter((j) => j.systemKey === "exchange").map((j) => j.id);

  if (licence.length === 0) {
    return { ok: false, error: "this case has no M365/Entra step to record the choice on", status: 422 };
  }

  if (policy === "convert") {
    if (exchange.length === 0) {
      return { ok: false, error: "this case has no Exchange step, so nothing here can convert the mailbox", status: 422 };
    }
    // No mailboxNotConvertedPolicy is written for `convert`. The licence step needs no policy to
    // unlicense a mailbox that IS shared — it will observe mailboxConverted=true (derived from the
    // exchange result at claim time) on its own re-run. Writing it too would be a second source of
    // truth for one fact, and the two would drift.
    return { ok: true, writes: [{ jobIds: exchange, key: "convertToShared", value: true }], requeue: [...exchange, ...licence] };
  }

  return { ok: true, writes: [{ jobIds: licence, key: "mailboxNotConvertedPolicy", value: policy }], requeue: [...licence] };
}
