// Authorization guards for Server Actions and Route Handlers. requireUser/requirePermission throw
// an AuthError (mapped to 401/403 by callers) when the signed-in operator is missing or lacks the
// capability. While AUTH_ENABLED is false they pass through as a synthetic system admin, preserving
// today's behavior so the foundation can land before the cutover.
import type { User } from "@prisma/client";
import { authEnabled, getCurrentUser, getActingContext, getRealUser } from "./current-user";
import { can, type Permission } from "./permissions";

export class AuthError extends Error {
  constructor(public status: 401 | 403, message: string) {
    super(message);
    this.name = "AuthError";
  }
}

// What guards return when auth is off — full access, no audited identity (actor stays "ui").
export type ActingUser = Pick<User, "id" | "email" | "name" | "role"> & { system?: boolean };
const SYSTEM: ActingUser = { id: "", email: "system", name: "system", role: "super_admin", system: true };

export async function requireUser(): Promise<ActingUser> {
  if (!authEnabled()) return SYSTEM;
  const u = await getCurrentUser();
  if (!u) throw new AuthError(401, "not signed in");
  return u;
}

export async function requirePermission(perm: Permission): Promise<ActingUser> {
  if (!authEnabled()) return SYSTEM;
  const ctx = await getActingContext();
  if (!ctx.user) throw new AuthError(401, "not signed in");
  // View-as impersonation is READ-ONLY: block every mutation while impersonating so nothing can be
  // changed AS another user (accountability). The super-admin exits first, then acts as themselves.
  if (ctx.impersonating) throw new AuthError(403, "you're viewing as another user — exit impersonation to make changes");
  if (!can(ctx.user.role, perm)) throw new AuthError(403, `your role (${ctx.user.role}) lacks permission: ${perm}`);
  return ctx.user;
}

// Gate for the impersonation endpoints themselves: the REAL operator (ignoring any active
// impersonation) must be a super-admin. Prevents an impersonated non-super session from starting a
// nested impersonation.
export async function requireRealSuperAdmin(): Promise<User> {
  if (!authEnabled()) throw new AuthError(403, "impersonation requires AUTH_ENABLED");
  const real = await getRealUser();
  if (!real) throw new AuthError(401, "not signed in");
  if (real.role !== "super_admin") throw new AuthError(403, "only a super admin can impersonate");
  return real;
}
