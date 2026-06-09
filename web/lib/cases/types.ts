// Shared types for the cases domain (repository + planning + import + routes/UI).
import type { Action, CaseStatus, JobStatus, Mode } from "@prisma/client";

export type NewCaseInput = {
  clientSlug: string;
  action: Action;
  serviceNowCaseNumber?: string | null;
  subject?: string | null;
  payload: Record<string, unknown>;
  dryRun?: boolean; // plan jobs in -WhatIf (read-only) mode
};

export type CaseListItem = {
  id: string;
  action: Action;
  status: CaseStatus;
  // Running/queued but blocked on a missing required credential — shown as "paused" in the list.
  paused: boolean;
  subject: string | null;
  serviceNowCaseNumber: string | null;
  createdAt: Date;
  clientName: string;
  clientSlug: string;
  jobCount: number;
  // Human explanation of the status for a hover tooltip: why it failed, what a queued case is
  // waiting on, which steps need a person / approval. Empty for self-explanatory states.
  statusHint: string;
  // Onboarding start date / offboarding date (date-only string from intake), per the action.
  effectiveDate: string | null;
};

export type TrashedCaseItem = {
  id: string;
  action: Action;
  status: CaseStatus;
  subject: string | null;
  serviceNowCaseNumber: string | null;
  deletedAt: Date;
  clientName: string;
  jobCount: number;
};

export type PlannedJobView = {
  id: string;
  systemKey: string;
  systemName: string;
  sequence: number;
  mode: Mode;
  status: JobStatus;
  requiresApproval: boolean;
  isManual: boolean; // mode !== api  -> checklist item
};

export type CaseDetail = {
  id: string;
  action: Action;
  status: CaseStatus;
  subject: string | null;
  dryRun: boolean;
  serviceNowCaseNumber: string | null;
  createdAt: Date;
  client: { name: string; slug: string };
  payload: Record<string, unknown>;
  jobs: PlannedJobView[];
};
