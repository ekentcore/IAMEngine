// A client's DEFAULT initial password for new users (FR #86), as the M365 password editor stores it
// on the m365 system's config (app/api/clients/[slug]/m365-password):
//   fixed  — a literal in config.onboard.initialPassword, which the app already holds, so it can be
//            shown to the operator to pass on to the client
//   secret — config.onboard.initialPasswordSecret names a Delinea reference; the app holds only the
//            reference, never the value, so only the reference is surfaced
//   null   — generated per user (the generate-mode one-time reveal covers that case)
import type { PrismaClient } from "@prisma/client";

export type DefaultPassword = { mode: "fixed"; value: string } | { mode: "secret"; secretName: string };

export function readDefaultPassword(config: unknown): DefaultPassword | null {
  const onboard = ((config ?? {}) as { onboard?: Record<string, unknown> }).onboard ?? {};
  const secretName = typeof onboard.initialPasswordSecret === "string" ? onboard.initialPasswordSecret.trim() : "";
  if (secretName) return { mode: "secret", secretName };
  const value = typeof onboard.initialPassword === "string" ? onboard.initialPassword : "";
  return value.trim() ? { mode: "fixed", value } : null;
}

// The default password that applies to a client's onboards: its own m365 system's, else — for a child
// that plans with its parent's systems — the parent's.
export async function clientDefaultPassword(db: PrismaClient, clientId: string): Promise<{ pw: DefaultPassword; ownerClientId: string } | null> {
  const own = await db.clientSystem.findFirst({ where: { clientId, systemKey: "m365" }, select: { config: true } });
  const ownPw = own ? readDefaultPassword(own.config) : null;
  if (ownPw) return { pw: ownPw, ownerClientId: clientId };
  const c = await db.client.findUnique({ where: { id: clientId }, select: { parentId: true, inheritParentSystems: true, _count: { select: { systems: true } } } });
  if (!c?.parentId || !c.inheritParentSystems || c._count.systems > 0) return null;
  const parent = await db.clientSystem.findFirst({ where: { clientId: c.parentId, systemKey: "m365" }, select: { config: true } });
  const parentPw = parent ? readDefaultPassword(parent.config) : null;
  return parentPw ? { pw: parentPw, ownerClientId: c.parentId } : null;
}
