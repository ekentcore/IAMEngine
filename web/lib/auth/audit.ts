// Per-user audit helper: stamps the acting operator's id + a "user:<email>" actor label onto an
// AuditLog row (falling back to a plain actor string for system/agent rows). Wrap mutations with
// this so the audit page can answer "who did what". Never throws into the caller's happy path.
import { db } from "@/lib/db";
import type { ActingUser } from "./guard";

type AuditOpts = {
  user?: ActingUser | null;
  actor?: string; // explicit label when there's no user (e.g. "system:auto-retry")
  clientId?: string | null;
  caseRequestId?: string | null;
  jobId?: string | null;
  detail?: unknown;
};

// The actor string for an action attributed to a user ("user:<email>"), or `fallback` when there's
// no signed-in user (auth off / system). Use when an action's actor is threaded as a plain string
// (e.g. the planning service's `actor` param) rather than written via recordAudit.
export function actorLabel(user: ActingUser | null | undefined, fallback: string): string {
  return user && !user.system ? `user:${user.email}` : fallback;
}

export async function recordAudit(action: string, opts: AuditOpts = {}): Promise<void> {
  const user = opts.user && !opts.user.system ? opts.user : null;
  try {
    await db.auditLog.create({
      data: {
        action,
        actor: user ? `user:${user.email}` : (opts.actor ?? "ui"),
        userId: user?.id ?? null,
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
