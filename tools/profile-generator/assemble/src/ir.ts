// TypeScript view of the profile-generator IR. Keep in lockstep with ../../ir.schema.json.

export type Action = "onboarding" | "offboarding";
export type Backbone = "entra" | "google" | "ad-synced" | "ad-standalone";

// Typed non-step content a section carries (email template, linked file). Filled from a
// pulled UM case at run time; rendered as a block in the runbook.
export interface EmailArtifact {
  type: "email";
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  fields?: string[];
}
export interface AttachmentArtifact {
  type: "attachment";
  href: string;
  sysId?: string | null;
  filename?: string;
}
export type Artifact = EmailArtifact | AttachmentArtifact;

export interface Detected {
  systemKey: string;
  action: Action;
  section: string;
  seq?: number;
  confidence: number;
  mode?: "api" | "browser" | "manual";
  signals?: Record<string, unknown>;
  steps?: string[];
  artifacts?: Artifact[];
}

export interface Unmodeled {
  section: string;
  action: Action;
  seq?: number;
  guess?: string | null;
  steps?: string[];
  artifacts?: Artifact[];
}

export interface IR {
  irVersion: "1.0";
  client: {
    leaf: string;
    path: string;
    suggestedId?: string;
    family?: "cvp" | "olympus" | null;
    domainRaw?: string | null;
    primaryDomain?: string | null;
  };
  kb: { onboard?: string | null; offboard?: string | null };
  actions: Action[];
  backboneHint?: Backbone | null;
  detected: Detected[];
  unmodeled: Unmodeled[];
  warnings?: string[];
}
