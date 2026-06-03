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
  coreId: string | null;
  region: string | null;
  supportStatus: string | null;
  onboardingRating: number | null;
  offboardingRating: number | null;
  snLastSyncedAt: Date | null;
  editedFields: string[]; // fields hand-edited in the UI (sync skips them)
  systemKeys: string[];
  systemCount: number;
  modeled: boolean; // has at least one ClientSystem (i.e. a profile was applied)
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
