// Authorization is permission-based: each Role maps to a fine-grained permission set, so roles stay
// easy to re-compose and every guard checks a capability, not a role name. Keep ROLE_PERMISSIONS in
// sync with the role matrix in the auth plan.
import type { Role } from "@prisma/client";

export type Permission =
  | "case.view"
  | "case.import"
  | "case.plan" // re-plan against current systems
  | "case.dispatch" // run / re-run / pause / verify / mark-manual / procurement watch
  | "case.approve_destructive" // approve a requiresApproval (destructive offboard) step
  | "case.schedule"
  | "client.edit_systems"
  | "client.edit_secrets" // wire Delinea references (still references only, never values)
  | "agent.manage" // enroll / enable / trash / update runners
  | "user.manage" // create users, set roles, reset passwords
  | "settings.manage"
  | "audit.view";

export const ALL_PERMISSIONS: Permission[] = [
  "case.view", "case.import", "case.plan", "case.dispatch", "case.approve_destructive", "case.schedule",
  "client.edit_systems", "client.edit_secrets", "agent.manage", "user.manage", "settings.manage", "audit.view",
];

const CASE_OPS: Permission[] = ["case.view", "case.import", "case.plan", "case.dispatch", "case.schedule"];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  global_admin: ALL_PERMISSIONS,
  ops_manager: [...CASE_OPS, "case.approve_destructive", "client.edit_systems", "client.edit_secrets", "agent.manage", "audit.view"],
  engineer: [...CASE_OPS, "client.edit_secrets"],
  importer: ["case.view", "case.import"],
  auditor: ["case.view", "audit.view"],
};

export function permissionsFor(role: Role): Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

export function can(role: Role, perm: Permission): boolean {
  return permissionsFor(role).includes(perm);
}

// Human labels for the role picker / audit display.
export const ROLE_LABELS: Record<Role, string> = {
  global_admin: "Global admin",
  ops_manager: "Operations manager",
  engineer: "Engineer",
  importer: "Importer",
  auditor: "Auditor (read-only)",
};
