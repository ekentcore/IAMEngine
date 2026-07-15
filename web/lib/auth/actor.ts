// The actor half of auditing, with NO database import — so services and repositories can stamp an
// operator onto an audit row without pulling in the Prisma singleton (and so they stay unit-testable
// against a fake db). `recordAudit` in ./audit.ts is the write side; this is the identity side.

// Structural, not an import of ActingUser — this module must not reach into the auth stack.
type MaybeUser = { id: string; email: string; system?: boolean } | null | undefined;

// An actor with BOTH halves of its identity: the human-readable label ("user:jane@core.tech") and
// the User FK that makes it queryable/joinable. Services that used to thread a bare `actor: string`
// take `ActorInput` instead, so attribution survives the trip down to writeAudit — a label alone
// leaves AuditLog.userId null and the row unattributable to a real account.
export type AuditActor = { label: string; userId: string | null };
export type ActorInput = string | AuditActor;

// Build an AuditActor from the signed-in operator, or `fallback` when there's no user (auth off, or
// a system/cron caller). The synthetic AUTH_ENABLED=false admin counts as "no user".
export function auditActor(user: MaybeUser, fallback: string): AuditActor {
  const u = user && !user.system ? user : null;
  return { label: u ? `user:${u.email}` : fallback, userId: u?.id ?? null };
}

// The actor string alone ("user:<email>"), for the few paths that still thread a plain string.
// Prefer auditActor() — this form cannot carry the userId FK.
export function actorLabel(user: MaybeUser, fallback: string): string {
  return user && !user.system ? `user:${user.email}` : fallback;
}

// Normalize either shape into the columns AuditLog wants. A bare string carries no userId — that's
// correct for genuine system/agent actors ("system:intake-poll", "agent:<id>").
export function resolveActor(
  actor: ActorInput | null | undefined,
  fallback = "ui"
): { actor: string; userId: string | null } {
  if (!actor) return { actor: fallback, userId: null };
  if (typeof actor === "string") return { actor: actor || fallback, userId: null };
  return { actor: actor.label || fallback, userId: actor.userId ?? null };
}
