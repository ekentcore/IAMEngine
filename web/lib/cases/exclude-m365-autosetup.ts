import { Prisma } from "@prisma/client"; // value import — Prisma.DbNull is used at runtime

// The synthetic onboard case that hosts a lone entra-devicecode browser job carries this marker in
// its payload (see lib/secrets/dispatch-device-code-job.ts). It isn't a real intake case, so list
// and bulk-replan queries exclude it.
export const M365_AUTOSETUP_MARKER = "m365AutoSetup" as const;

// Same idea for the synthetic onboard cases that host the two Google Workspace browser jobs
// (google-oauth-signin / google-dwd-grant — see lib/secrets/dispatch-google-browser-job.ts). A
// separate marker rather than reusing M365_AUTOSETUP_MARKER: these aren't m365 cases, and keeping
// per-provider markers means widening this helper again for a future provider is the same additive
// shape (add a marker, AND in its exclude branch) instead of overloading one name across providers.
export const GOOGLE_AUTOSETUP_MARKER = "googleAutoSetup" as const;

// Same idea for the synthetic onboard case that hosts a Mimecast console browser job
// (mimecast-console-setup — see lib/secrets/dispatch-mimecast-console-job.ts). Its own marker, same
// additive shape as the others.
export const MIMECAST_AUTOSETUP_MARKER = "mimecastAutoSetup" as const;

// ONE shared marker for the generalized per-module browser setups (Spanning/Adobe/Zoom/… console
// harvest — see lib/secrets/dispatch-*-console-job.ts). Unlike the per-provider markers above, the
// generalized vendor setups all reuse this single marker so each new vendor PR needs NO edit to this
// filter — it just stamps MODULE_AUTOSETUP_MARKER on its synthetic case.
export const MODULE_AUTOSETUP_MARKER = "moduleAutoSetup" as const;

// Per-marker "exclude rows where this marker is true" fragment. The obvious
// `NOT: { payload: { path: [marker], equals: true } }` is WRONG on its own: for the overwhelming
// majority of cases the payload has no marker key at all, so the JSON path resolves to SQL NULL,
// `NULL = true` is NULL, and `NOT NULL` is NULL — which Postgres treats as "not matched". That
// silently drops EVERY normal case (this emptied the whole /cases queue after PR #131). We must
// also explicitly keep the rows whose path is NULL (key absent → Prisma.DbNull). Every marker this
// helper excludes MUST go through this same OR-with-DbNull shape — never a bare NOT.
function excludeMarkerTrue(marker: string): Prisma.CaseRequestWhereInput {
  return {
    OR: [
      { NOT: { payload: { path: [marker], equals: true } } },
      { payload: { path: [marker], equals: Prisma.DbNull } },
    ],
  };
}

// A Prisma where-fragment that matches every case EXCEPT the synthetic auto-setup ones (m365 or
// google). Each marker is excluded via its own OR-with-DbNull branch (see excludeMarkerTrue above);
// the AND across markers is independent — a case can only be flagged by at most one dispatcher, so
// this reads as "keep it unless SOME marker is true", not a joint condition.
export const notM365AutoSetupCase: Prisma.CaseRequestWhereInput = {
  AND: [excludeMarkerTrue(M365_AUTOSETUP_MARKER), excludeMarkerTrue(GOOGLE_AUTOSETUP_MARKER), excludeMarkerTrue(MIMECAST_AUTOSETUP_MARKER), excludeMarkerTrue(MODULE_AUTOSETUP_MARKER)],
};
