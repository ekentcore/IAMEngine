// Site-wide "Version 2" mode. A per-operator opt-in stored in a cookie; when on, middleware routes
// the canonical pages to their /v2 variants (and routes /v2 back to canonical when off, so the
// toggle is the single source of truth). Only the pages listed here have a v2 yet.
export const V2_COOKIE = "site_v2";

// canonical base path -> its v2 route. EXACT match only, so detail pages (/cases/<id>, /clients/<slug>)
// and v2 subpages (/clients/v2/review) are never touched.
export const V2_ROUTES: Record<string, string> = {
  "/clients": "/clients/v2",
  "/cases": "/cases/v2",
  "/audit": "/audit/v2",
  "/users": "/users/v2",
  "/agents": "/agents/v2",
};

// reverse: v2 route -> canonical base.
export const V2_CANONICAL: Record<string, string> = Object.fromEntries(
  Object.entries(V2_ROUTES).map(([base, v2]) => [v2, base]),
);

export function v2Enabled(cookieValue: string | undefined): boolean {
  return cookieValue === "on";
}
