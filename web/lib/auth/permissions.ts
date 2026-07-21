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
  | "client.archive" // archive / restore a client — restricted to client_offboarding + global/super
  | "agent.manage" // enroll / enable / trash / update runners
  | "user.manage" // create users, set roles, reset passwords
  | "settings.manage"
  | "feature_request.hide" // hide an implemented request early, or grant it another 7 days on the board
  | "connector.manage" // author/publish low-code connectors — publish creates a claimable system, so global_admin only
  | "audit.view";

export const ALL_PERMISSIONS: Permission[] = [
  "case.view", "case.import", "case.plan", "case.dispatch", "case.approve_destructive", "case.schedule",
  "client.edit_systems", "client.edit_secrets", "client.archive", "agent.manage", "user.manage", "settings.manage",
  "feature_request.hide", "connector.manage", "audit.view",
];

const CASE_OPS: Permission[] = ["case.view", "case.import", "case.plan", "case.dispatch", "case.schedule"];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  super_admin: ALL_PERMISSIONS, // same capabilities as global; the difference is the super-only guards below
  global_admin: ALL_PERMISSIONS,
  ops_manager: [...CASE_OPS, "case.approve_destructive", "client.edit_systems", "client.edit_secrets", "agent.manage", "audit.view"],
  engineer: [...CASE_OPS, "client.edit_secrets"],
  importer: ["case.view", "case.import"],
  auditor: ["case.view", "audit.view"],
  // Client-lifecycle roles: add + modify + set up clients (edit systems + wire credentials), plus
  // read-only case visibility — but NOT running cases. Offboarding additionally may archive clients.
  // NB: archive is client.archive, held only here (offboarding) + global/super — NOT ops_manager.
  client_onboarding: ["case.view", "client.edit_systems", "client.edit_secrets"],
  client_offboarding: ["case.view", "client.edit_systems", "client.edit_secrets", "client.archive"],
};

// Seniority ranking (higher = more powerful). Drives the password-reset / role-assignment rules:
// you can only reset or re-role someone at or below your own rank, and the super tier is touched
// ONLY by another super.
export const ROLE_RANK: Record<Role, number> = {
  super_admin: 5,
  global_admin: 4,
  ops_manager: 3,
  // Client-lifecycle roles sit below global_admin (so a global can always manage them) and don't hold
  // user.manage, so their rank only ever matters as a target. Offboarding ranks above onboarding.
  client_offboarding: 3,
  client_onboarding: 2,
  engineer: 2,
  importer: 1,
  auditor: 0,
};

// Who may RESET a user's password:
//   - super_admin  -> anyone (including other supers)
//   - global_admin -> anyone global_admin or LOWER (never a super)
//   - below global -> no one (they lack user.manage)
// i.e. you must hold user.manage AND be at least as senior as the target.
export function canResetPassword(actor: Role, target: Role): boolean {
  return can(actor, "user.manage") && ROLE_RANK[actor] >= ROLE_RANK[target];
}

// Who may ASSIGN/CHANGE a role: granting or modifying the super_admin tier is super-only (so a global
// can't self-promote to super or demote a super to dodge the reset rule). Everything below is the
// usual user.manage capability.
export function canAssignRole(actor: Role, targetCurrentRole: Role, newRole: Role): boolean {
  if (newRole === "super_admin" || targetCurrentRole === "super_admin") return actor === "super_admin";
  return can(actor, "user.manage");
}

export function permissionsFor(role: Role): Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

export function can(role: Role, perm: Permission): boolean {
  return permissionsFor(role).includes(perm);
}

// Human labels for the role picker / audit display.
export const ROLE_LABELS: Record<Role, string> = {
  super_admin: "Super admin",
  global_admin: "Global admin",
  ops_manager: "Operations manager",
  engineer: "Engineer",
  importer: "Importer",
  auditor: "Auditor (read-only)",
  client_onboarding: "Client onboarding",
  client_offboarding: "Client offboarding",
};

// One-line plain-English summary of each role (shown on the Users page + as hover text).
export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  super_admin: "Top tier. Everything a global admin can do, and the only role that can reset a super admin's password or grant/remove the super admin role.",
  global_admin: "Full control — everything below, plus managing users, roles, and settings. Cannot reset a super admin's password.",
  ops_manager: "Runs AND approves everything operational, including destructive offboard steps; can edit client systems and manage runners. Cannot manage users.",
  engineer: "Runs onboardings & offboardings — import, plan, schedule, dispatch, re-run, verify. Cannot approve destructive offboard steps (a manager does that).",
  importer: "Imports cases and views them. Cannot run anything.",
  auditor: "Read-only — views cases and the audit log. Makes no changes.",
  client_onboarding: "Adds, modifies, and sets up clients — edit systems and wire credential references, plus read-only case visibility. Cannot run cases or archive clients.",
  client_offboarding: "Everything Client onboarding can do, plus archiving (and restoring) clients. Cannot run cases. Archiving is limited to this role and global/super admins.",
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
  "client.archive": "Archive & restore clients",
  "agent.manage": "Manage runners (agents)",
  "user.manage": "Manage users & roles",
  "settings.manage": "Manage settings",
  "feature_request.hide": "Hide / restore completed feature requests",
  "connector.manage": "Author & publish low-code connectors",
  "audit.view": "View the audit log",
};
