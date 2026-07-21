// Per-user audit helper: stamps the acting operator's id + a "user:<email>" actor label onto an
// AuditLog row (falling back to a plain actor string for system/agent rows). Wrap mutations with
// this so the audit page can answer "who did what". Never throws into the caller's happy path.
//
// The identity half lives in ./actor (no db import) so repositories and services can carry an actor
// without pulling in Prisma; re-exported here so callers have one place to import from.
import { db } from "@/lib/db";
import type { ActingUser } from "./guard";
import { resolveActor, type ActorInput } from "./actor";

export { auditActor, actorLabel, resolveActor } from "./actor";
export type { AuditActor, ActorInput } from "./actor";

type AuditOpts = {
  user?: ActingUser | null;
  // A label string ("system:auto-retry"), OR an AuditActor that ALSO carries a userId — the latter
  // records "automation on behalf of a user" (the runner/background job did it, but a person kicked
  // it off): a non-`user:` actor label with the initiating user's id, which the audit view renders as
  // "Name (Automation)".
  actor?: ActorInput;
  clientId?: string | null;
  caseRequestId?: string | null;
  jobId?: string | null;
  detail?: unknown;
};

export async function recordAudit(action: string, opts: AuditOpts = {}): Promise<void> {
  const user = opts.user && !opts.user.system ? opts.user : null;
  const via = resolveActor(opts.actor); // label + (for an AuditActor) the on-behalf-of userId
  try {
    await db.auditLog.create({
      data: {
        action,
        actor: user ? `user:${user.email}` : via.actor,
        userId: user?.id ?? via.userId,
        clientId: opts.clientId ?? null,
        caseRequestId: opts.caseRequestId ?? null,
        jobId: opts.jobId ?? null,
        detail: (opts.detail ?? undefined) as never,
      },
    });
  } catch {
    // auditing must never break the action it records
  }
}
