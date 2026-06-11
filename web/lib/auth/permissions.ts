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

// One-line plain-English summary of each role (shown on the Users page + as hover text).
export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  global_admin: "Full control — everything below, plus managing users, roles, and settings.",
  ops_manager: "Runs AND approves everything operational, including destructive offboard steps; can edit client systems and manage runners. Cannot manage users.",
  engineer: "Runs onboardings & offboardings — import, plan, schedule, dispatch, re-run, verify. Cannot approve destructive offboard steps (a manager does that).",
  importer: "Imports cases and views them. Cannot run anything.",
  auditor: "Read-only — views cases and the audit log. Makes no changes.",
};

// Human labels for each capability (so the UI never shows raw "case.dispatch" keys).
export const PERMISSION_LABELS: Record<Permission, string> = {
  "case.view": "View cases",
  "case.import": "Import cases from ServiceNow",
  "case.plan": "Re-plan cases",
  "case.dispatch": "Run / re-run / pause / verify steps",
  "case.approve_destructive": "Approve destructive offboard steps",
  "case.schedule": "Schedule cases",
  "client.edit_systems": "Edit client systems & runbooks",
  "client.edit_secrets": "Wire credential references",
  "agent.manage": "Manage runners (agents)",
  "user.manage": "Manage users & roles",
  "settings.manage": "Manage settings",
  "audit.view": "View the audit log",
};
