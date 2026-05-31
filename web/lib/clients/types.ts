// Shared types for the clients domain (repository + sync service + routes/UI).
import type { Client, ClientStatus, Backbone } from "@prisma/client";

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
  systemKeys: string[];
  systemCount: number;
  modeled: boolean; // has at least one ClientSystem (i.e. a profile was applied)
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
    mode: string;
    onboardWhen: string;
    offboardWhen: string;
    requiresApproval: boolean;
    captureEvidence: boolean;
    secretNames: string[];
    system: { name: string; buildTier: number; moduleName: string | null };
  }>;
  secrets: Array<{ name: string; provider: string; label: string | null }>;
};
