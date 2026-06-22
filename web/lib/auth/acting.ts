// Non-throwing capability checks for the CURRENT operator, for UI gating in server components
// (e.g. "show the restricted toggle only to a user.manage admin"). Mutations still enforce via
// requirePermission server-side — this only decides what to render. Auth off → full access.
import { authEnabled, getCurrentUser } from "./current-user";
import { can, type Permission } from "./permissions";

export async function currentCan(perm: Permission): Promise<boolean> {
  if (!authEnabled()) return true; // synthetic system super-admin
  const me = await getCurrentUser();
  return !!me && can(me.role, perm);
}
