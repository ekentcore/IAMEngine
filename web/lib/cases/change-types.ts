// Shared contract for the "change" (mover / ad-hoc access) action. The web planner writes
// ChangeJobConfig onto each directory job's config; the runner Change lane reads the same keys.
export type ChangeKind = "mover" | "adhoc";
export type RemovalMode = "scoped" | "full" | "add-only";
export type ChangeTarget = "group" | "dl" | "sharedMailbox" | "license" | "ou" | "attribute";

// One hand-picked delta (ad-hoc path). `value` is a group/DL/mailbox/license name, an OU DN,
// or "key=value" for an attribute. `system` optionally narrows to one directory systemKey.
export type ChangeDelta = {
  op: "add" | "remove";
  target: ChangeTarget;
  value: string;
  system?: string;
};

export type ChangePayload = {
  userToChange: string; // display name or UPN of the EXISTING user
  changeKind: ChangeKind;
  // mover:
  fromPersona?: string;
  toPersona?: string;
  fromLocation?: string;
  toLocation?: string;
  removalMode?: RemovalMode; // set on confirm from the preview modal
  // adhoc:
  deltas?: ChangeDelta[];
};

// Per-directory diff, one per active directory systemKey.
export type ChangeDiff = {
  systemKey: string;
  add: string[]; // groups to add (idempotent at the runner)
  removeGroups: string[]; // named groups to remove (scoped mode)
  reconcileGroups: boolean; // full mode → runner removes anything not in desiredGroups
  desiredGroups: string[]; // reconcile keep-list (the target group set)
  moveToOu?: string; // AD only, full DN
  attributes?: Record<string, unknown>;
  licenses?: unknown[]; // m365 only, add
  removeLicenses?: string[]; // m365 only
  namedGroups?: string[]; // exchange: DL/365-group add by name
  removeNamedGroups?: string[]; // exchange: DL/365-group remove by name
  addSharedMailboxes?: string[];
  removeSharedMailboxes?: string[];
};

// What lands on job.config (the runner Change lane's read contract).
export type ChangeJobConfig = Omit<ChangeDiff, "systemKey" | "add"> & { groups: string[] };

// Directory systems whose group/OU/attr/license state the change lane manages.
export const DIRECTORY_SYSTEMS = ["active-directory", "entra", "m365", "exchange", "google-workspace"] as const;

export const PROTECTED_GROUPS: ReadonlySet<string> = new Set(
  [
    "domain admins", "enterprise admins", "schema admins", "administrators",
    "account operators", "backup operators", "server operators", "print operators",
    "group policy creator owners", "dnsadmins", "key admins", "enterprise key admins",
  ].map((g) => g.toLowerCase())
);

export function isProtectedGroup(name: string): boolean {
  return PROTECTED_GROUPS.has(name.trim().toLowerCase());
}
