// Minimal TypeScript view of the v2 profile (profiles/_schema.json) — enough to build one.
import type { Backbone } from "./ir.js";

export interface SecretRef { provider: "delinea"; id: string; label?: string }

export interface Lane {
  when?: "always" | "on-request" | "never";
  dependsOn?: string[];
  requiresApproval?: boolean;
  captureEvidence?: boolean;
  schedule?: { offsetDaysMin?: number; offsetDaysMax?: number; note?: string };
  guardrails?: string[];
  config?: Record<string, unknown>;
}

export interface SystemEntry {
  key: string;
  mode: "api" | "browser" | "manual";
  secrets?: string[];
  dependsOn?: string[];
  stopOnError?: boolean;
  onboard?: Lane;
  offboard?: Lane;
}

export interface Profile {
  schemaVersion: "2.0" | "2.1"; // 2.1 when the v2.1 enrichment added personas/globals/locations
  client: { id: string; name: string; primaryDomain: string; domains?: string[]; pod?: string };
  identity: {
    backbone: Backbone;
    usernamePatterns: string[];
    lowercase?: boolean;
    password?: Record<string, unknown>;
    directorySync?: { host?: string; command?: string };
  };
  secrets: Record<string, SecretRef>;
  delivery?: { method: string; welcomeLetter?: boolean; note?: string };
  systems: SystemEntry[];
  // v2.1 plan-time blocks (added by the optional --v21 enrichment; absent for plain v2.0 drafts)
  globals?: Record<string, Record<string, unknown>>;
  personas?: Record<string, unknown>;
  locations?: Record<string, unknown>;
}

export interface DraftMeta {
  id: string;
  name: string;
  confidence: number;
  band: "high" | "medium" | "low";
  backbone: Backbone;
  backboneDefaulted: boolean;
  primaryDomainMissing: boolean;
  systemCount: number;
  unmodeledCount: number;
  unmodeled: string[];
  family: string | null;
  kb: { onboard?: string | null; offboard?: string | null };
  warnings: string[];
}
