// Authorization guards for Server Actions and Route Handlers. requireUser/requirePermission throw
// an AuthError (mapped to 401/403 by callers) when the signed-in operator is missing or lacks the
// capability. While AUTH_ENABLED is false they pass through as a synthetic system admin, preserving
// today's behavior so the foundation can land before the cutover.
import type { User } from "@prisma/client";
import { authEnabled, getCurrentUser } from "./current-user";
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
  const u = await requireUser();
  if (!u.system && !can(u.role, perm)) throw new AuthError(403, `your role (${u.role}) lacks permission: ${perm}`);
  return u;
}
