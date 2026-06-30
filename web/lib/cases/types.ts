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
  // Freshly imported from ServiceNow and held for review with no activity yet — shown as "imported".
  imported: boolean;
  // Why it's paused: every import is held — "needs_info" (intake unknowns to fill), "scheduled" (a
  // possibly-future-dated offboard), "review" (a ready case awaiting an operator's go) — plus an
  // explicit operator pause or missing credentials. null when not paused.
  pausedBy: "needs_info" | "scheduled" | "review" | "operator" | "creds" | null;
  // For completed cases: the steps' warning lines (WARN actions / missed validations), with the
  // system name prefixed. Empty = a clean green "completed"; non-empty renders orange with these
  // on hover. Always [] for non-completed cases.
  warnings: string[];
  subject: string | null;
  serviceNowCaseNumber: string | null;
  createdAt: Date;
  clientName: string;
  clientSlug: string;
  jobCount: number;
  // Human explanation of the status for a hover tooltip: why it failed, what a queued case is
  // waiting on, which steps need a person / approval. Empty for self-explanatory states.
  statusHint: string;
  // Onboarding start date / offboarding date (date-only string from intake or subject), per the
  // action. null when none — see `immediate` for an offboard with no scheduled date.
  effectiveDate: string | null;
  // Offboard with no future date — the subject says "Immediate" (process now). Shown instead of a date.
  immediate: boolean;
  // When the case last executed (most recent job start/finish), and which operator last ran it
  // (import/plan, re-run, resume, verify — "user:<email>" stripped to the email). null = never / no auth.
  lastRunAt: Date | null;
  ranBy: string | null;
  // The most recent tracked action on the case and who took it — "Imported"/"Unpaused"/"Paused"/
  // "Verified"/… shown under the status badge. lastActionBy is the operator's email, or null when
  // the actor wasn't a signed-in user (auth off).
  lastActionLabel: string | null;
  lastActionBy: string | null;
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
