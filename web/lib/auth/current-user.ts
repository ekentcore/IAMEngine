// Resolve the signed-in operator from the session cookie. Runs in the Node runtime (Server
// Components / Route Handlers / Server Actions) where Prisma is available — NOT in edge middleware,
// which only checks cookie presence. authEnabled() is the rollout flag: while false the app behaves
// exactly as before (no login required) so the cutover is deliberate and can't lock anyone out.
import { cookies } from "next/headers";
import type { User } from "@prisma/client";
import { db } from "@/lib/db";
import { SESSION_COOKIE, hashToken } from "./session";

export function authEnabled(): boolean {
  return process.env.AUTH_ENABLED === "true";
}

// The acting context for the current session: the EFFECTIVE user (what the app renders as — the
// impersonated user when a super-admin is "viewing as" someone, else the real operator), the REAL
// operator, and whether impersonation is active. getCurrentUser returns the effective user, so all
// downstream RBAC + client-scoping automatically reflect the impersonated user — no other change needed.
export type ActingContext = { user: User | null; realUser: User | null; impersonating: boolean };

export async function getActingContext(): Promise<ActingContext> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return { user: null, realUser: null, impersonating: false };
  const session = await db.session.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
  if (!session || session.revokedAt || session.expiresAt < new Date()) return { user: null, realUser: null, impersonating: false };
  const realUser = session.user;
  if (realUser.status !== "active") return { user: null, realUser: null, impersonating: false };
  // Impersonation only takes effect for a super-admin session (defence-in-depth: even if the column
  // were set on a non-super session, it's ignored). Falls back to the real user if the target is
  // missing/inactive.
  if (session.impersonatingUserId && realUser.role === "super_admin") {
    const target = await db.user.findUnique({ where: { id: session.impersonatingUserId } });
    if (target && target.status === "active") return { user: target, realUser, impersonating: true };
  }
  return { user: realUser, realUser, impersonating: false };
}

export async function getCurrentUser(): Promise<User | null> {
  return (await getActingContext()).user;
}

// The REAL operator behind the session, regardless of impersonation — for the impersonation gate
// (only a real super-admin may start one) and the "acting as" banner.
export async function getRealUser(): Promise<User | null> {
  return (await getActingContext()).realUser;
}
