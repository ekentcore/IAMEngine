// Shared types for the cases domain (repository + planning + import + routes/UI).
import type { Action, CaseStatus, JobStatus, Mode } from "@prisma/client";

export type NewCaseInput = {
  clientSlug: string;
  action: Action;
  serviceNowCaseNumber?: string | null;
  subject?: string | null;
  payload: Record<string, unknown>;
};

export type CaseListItem = {
  id: string;
  action: Action;
  status: CaseStatus;
  subject: string | null;
  serviceNowCaseNumber: string | null;
  createdAt: Date;
  clientName: string;
  clientSlug: string;
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
  serviceNowCaseNumber: string | null;
  createdAt: Date;
  client: { name: string; slug: string };
  payload: Record<string, unknown>;
  jobs: PlannedJobView[];
};
