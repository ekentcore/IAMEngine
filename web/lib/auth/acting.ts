// Non-throwing role check for the CURRENT operator, for UI gating in server components (e.g. "show the
// restrict-client control only to a super admin"). Mutations still enforce server-side — this only
// decides what to render. Auth off → true (synthetic system super-admin).
import { authEnabled, getCurrentUser } from "./current-user";

export async function currentIsSuperAdmin(): Promise<boolean> {
  if (!authEnabled()) return true;
  const me = await getCurrentUser();
  return !!me && me.role === "super_admin";
}
