// Shared client-row vocabulary for the clients list variants (ClientsTable v1, ClientsExplorer v2)
// and the page loader: the wide view-model plus the badge/label constants and helpers both tables
// render with. One definition — a field or tier added here reaches every variant.
import type { Backbone, ClientStatus } from "@prisma/client";
import type { ClientReadiness } from "@/lib/clients/readiness";

export type ClientVM = {
  id: string;
  slug: string;
  name: string;
  primaryDomain: string;
  backbone: Backbone | null;
  status: ClientStatus;
  intakeSource: string;
  restricted: boolean;
  coreId: string | null;
  region: string | null;
  supportStatus: string | null;
  onboardingRating: number | null;
  offboardingRating: number | null;
  snLastSyncedAt: string | null;
  editedFields: string[];
  emailDomain: string | null;
  usernamePattern: string;
  systemKeys: string[];
  systemCount: number;
  modeled: boolean;
  readiness: ClientReadiness;
  parentId: string | null;
  parentName: string | null;
  parentSystemKeys: string[];
  coverage: "own" | "parent" | "none";
};

export const BACKBONE_LABEL: Record<string, string> = {
  entra: "Entra",
  google: "Google",
  ad_synced: "AD synced",
  ad_standalone: "AD standalone",
};

// Run-readiness badge styling per tier (computed from wired secrets + connection-test results).
export const READINESS: Record<string, { label: string; mark: string; color: string; bg: string }> = {
  ready: { label: "ready", mark: "✓", color: "var(--ok-fg)", bg: "var(--ok-bg)" },
  partial: { label: "partial", mark: "◑", color: "var(--warn-fg)", bg: "var(--warn-bg)" },
  not_set_up: { label: "not set up", mark: "✗", color: "var(--err-fg)", bg: "var(--err-bg)" },
  no_systems: { label: "—", mark: "", color: "var(--muted)", bg: "transparent" },
};

// A client modeled via its parent (SN account hierarchy) is planned from the PARENT's systems, so
// lists show the parent's systems + readiness (the parent's own row already has them computed),
// marked "via <parent>". Falls back to the parent's system keys if the parent row isn't in view.
export function effective(
  c: ClientVM,
  byId: Map<string, ClientVM>
): { readiness: ClientReadiness; systemCount: number; systemKeys: string[]; viaParent: string | null } {
  if (c.coverage === "parent") {
    const p = c.parentId ? byId.get(c.parentId) : undefined;
    if (p) return { readiness: p.readiness, systemCount: p.systemCount, systemKeys: p.systemKeys, viaParent: c.parentName ?? p.name };
    return { readiness: c.readiness, systemCount: c.parentSystemKeys.length, systemKeys: c.parentSystemKeys, viaParent: c.parentName };
  }
  return { readiness: c.readiness, systemCount: c.systemCount, systemKeys: c.systemKeys, viaParent: null };
}

// Live preview of an email/UPN name format using a fixed sample person, "John Jason Doe"
// (first John, middle Jason, last Doe). Mirrors the runner's applyUsernamePattern tokens.
export function formatPreview(localPattern: string, domain: string | null): string {
  const v: Record<string, string> = {
    first: "john", last: "doe", mi: "j", f: "j", l: "d", firstinitial: "j", lastinitial: "d",
  };
  const local = localPattern.replace(/\{[a-zA-Z]+\}/g, (tok) => {
    const k = tok.slice(1, -1).toLowerCase();
    return k in v ? v[k] : tok;
  });
  return `${local}@${domain || "domain.com"}`;
}
