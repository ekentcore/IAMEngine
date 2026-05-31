// TypeScript view of the profile-generator IR. Keep in lockstep with ../../ir.schema.json.

export type Action = "onboarding" | "offboarding";
export type Backbone = "entra" | "google" | "ad-synced" | "ad-standalone";

export interface Detected {
  systemKey: string;
  action: Action;
  section: string;
  confidence: number;
  mode?: "api" | "browser" | "manual";
  signals?: Record<string, unknown>;
}

export interface Unmodeled {
  section: string;
  action: Action;
  guess?: string | null;
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
