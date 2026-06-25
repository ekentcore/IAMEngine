// Shared types for the clients domain (repository + sync service + routes/UI).
import type { Client, ClientStatus, Backbone, Mode, Lifecycle } from "@prisma/client";

// Projection used by the list view — excludes the heavy ClientSystem.config JSON.
export type ClientListItem = {
  id: string;
  slug: string;
  name: string;
  primaryDomain: string;
  backbone: Backbone | null;
  status: ClientStatus;
  intakeSource: string; // "um" (external) | "incident" (internal) — which SN table to scan for cases
  restricted: boolean; // internal-only: hidden from operators not granted it (see lib/auth/client-scope)
  coreId: string | null;
  region: string | null;
  supportStatus: string | null;
  onboardingRating: number | null;
  offboardingRating: number | null;
  snLastSyncedAt: Date | null;
  editedFields: string[]; // fields hand-edited in the UI (sync skips them)
  emailDomain: string | null; // resolved email/UPN domain (for the format preview)
  usernamePattern: string; // email/UPN local-part format, e.g. "{first}.{last}"
  systemKeys: string[];
  systemCount: number;
  modeled: boolean; // has at least one ClientSystem of its OWN (a profile was applied)
  parentId: string | null;
  parentName: string | null;
  parentSystemKeys: string[]; // the parent's systems (shown in the hover for a via-parent client)
  coverage: "own" | "parent" | "none"; // own=modeled directly, parent=inherits a modeled parent, none=unmodeled
};

// One system as edited in the UI (full lanes + config). Lane values are the DB enum form.
export type EditableSystem = {
  systemKey: string;
  mode: "api" | "browser" | "manual";
  onboardWhen: "always" | "on_request" | "never";
  offboardWhen: "always" | "on_request" | "never";
  dependsOn: string[];
  requiresApproval: boolean;
  captureEvidence: boolean;
  secretNames: string[];
  config: unknown; // free-form JSON
};

export type CreateClientInput = {
  name: string;
  primaryDomain: string;
  backbone?: Backbone | null;
  coreId?: string | null;
  pod?: string | null;
};

export type SyncResult = {
  total: number; // SN records seen
  created: number; // new roster-only clients
  updated: number; // existing clients matched by sysId, refreshed
  reconciled: number; // profile/manual clients linked to their SN record by domain
  errors: Array<{ sysId: string; name: string; reason: string }>;
};

export type AuditEntry = {
  actor: string;
  action: string;
  clientId?: string | null;
  caseRequestId?: string | null;
  detail?: unknown;
};

export type ClientDetail = Client & {
  systems: Array<{
    id: string;
    systemKey: string;
    mode: Mode;
    onboardWhen: Lifecycle;
    offboardWhen: Lifecycle;
    dependsOn: string[];
    requiresApproval: boolean;
    captureEvidence: boolean;
    secretNames: string[];
    config: unknown;
    system: { name: string; buildTier: number; moduleName: string | null };
  }>;
  secrets: Array<{ name: string; provider: string; label: string | null }>;
};
