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
  engineOptOut: boolean;
  inheritParentSystems: boolean;
  inheritParentModeling: boolean;
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

export type EffectiveView = ReturnType<typeof effective>;

// Everything a row exposes, flattened for search — matches what you can SEE (incl. the Backbone,
// Systems, and Ready columns, resolved via-parent) and the slug. Shared by both tables so the
// same query can't return different rows on /clients vs /clients/v2.
export function haystack(c: ClientVM, e: EffectiveView): string {
  return [
    c.name, c.slug, c.coreId, c.region, c.primaryDomain, c.supportStatus, c.usernamePattern,
    c.backbone ? BACKBONE_LABEL[c.backbone] ?? c.backbone : "",
    e.systemKeys.join(" "),
    e.readiness ? READINESS[e.readiness.tier]?.label : "",
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

// null/empty sorts last regardless of direction. Shared sort semantics for both tables.
export function compareClients(a: ClientVM, b: ClientVM, key: keyof ClientVM): number {
  const av = a[key] as string | number | null;
  const bv = b[key] as string | number | null;
  const aEmpty = av === null || av === "";
  const bEmpty = bv === null || bv === "";
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  if (typeof av === "number" && typeof bv === "number") return av - bv;
  return String(av).localeCompare(String(bv));
}

// modeled/readiness tallies for the filter dropdowns, in ONE pass over the rows (the dropdowns
// only need five integers — no reason to filter the roster five times).
export function tallyCounts(rows: ClientVM[], eff: (c: ClientVM) => EffectiveView) {
  const counts = { total: rows.length, modeled: 0, unmodeled: 0, ready: 0, partial: 0, not_set_up: 0, no_systems: 0 };
  for (const c of rows) {
    if (c.modeled) counts.modeled++; else counts.unmodeled++;
    const tier = (eff(c).readiness?.tier ?? "no_systems") as "ready" | "partial" | "not_set_up" | "no_systems";
    counts[tier]++;
  }
  return counts;
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
