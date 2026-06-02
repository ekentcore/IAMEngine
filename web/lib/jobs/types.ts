// Shapes for the runner-facing API (see docs/RUNNER_PROTOCOL.md).
import type { Action, Backbone, Mode } from "@prisma/client";

// What a runner receives per claimed job.
export type RunnerJob = {
  id: string;
  action: Action;
  systemKey: string;
  mode: Mode;
  client: { slug: string; primaryDomain: string; backbone: Backbone | null };
  config: unknown;
  secretNames: string[];
  payload: unknown;
  requiresApproval: boolean;
  captureEvidence: boolean;
  dryRun: boolean; // when true the runner runs -WhatIf (no mutations) + validation-only read-backs
};

export type ResultInput = {
  status: "succeeded" | "failed" | "skipped";
  result?: unknown;
  evidence?: unknown;
  // Post-action read-back: { ok, checks:[{name,expected,actual,pass}] }. A miss (ok=false) does
  // NOT fail the job/case — the run report flags it as a warning. Re-validation can clear it.
  validation?: unknown;
  error?: string | null;
};

export type BrokeredCredential = {
  provider: string;
  externalId: string;
  secretName: string;
  brokered: boolean; // true once the app has preflighted the reference against Delinea
  expiresInSeconds: number;
  label?: string; // Delinea secret name (a human label) — never the secret value
  note?: string;
};

// Lets the service signal an HTTP status; routes translate it to a response.
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
