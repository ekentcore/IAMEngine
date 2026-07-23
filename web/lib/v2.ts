// Site-wide UI versioning. Each page belongs to a "family" with a route per version. v1 (the bare
// canonical path, e.g. /cases) is RETIRED: it always resolves to v2, whatever the cookie says. The
// operator's slider then chooses between v2 and v3, stored in the `site_version` cookie and read by
// middleware to route between the /v2 and /v3 variants. A family with no v3 route yet falls back to
// v2 in v3 mode, so the slider never lands on a 404.
export const SITE_VERSION_COOKIE = "site_version";

export type SiteVersion = "v2" | "v3";

// One entry per versioned page. `base` is the retired v1 path (always redirected away). `v3` is
// present ONLY for pages that actually have a /v3 route built — the middleware redirect targets it,
// so omitting it means "stay on v2 in v3 mode" rather than a broken redirect to a missing route.
type PageFamily = { base: string; v2: string; v3?: string };

const FAMILIES: PageFamily[] = [
  { base: "/clients", v2: "/clients/v2", v3: "/clients/v3" },
  { base: "/cases", v2: "/cases/v2", v3: "/cases/v3" },
  { base: "/audit", v2: "/audit/v2", v3: "/audit/v3" },
  { base: "/users", v2: "/users/v2", v3: "/users/v3" },
  { base: "/agents", v2: "/agents/v2", v3: "/agents/v3" },
  { base: "/runs", v2: "/runs/v2", v3: "/runs/v3" },
  { base: "/modules", v2: "/modules/v2", v3: "/modules/v3" },
  // Sub-path needs its own entry — matching is exact, so "/health" doesn't cover "/health/connections".
  { base: "/health/connections", v2: "/health/connections/v2", v3: "/health/connections/v3" },
  { base: "/health", v2: "/health/v2", v3: "/health/v3" },
  { base: "/settings", v2: "/settings/v2", v3: "/settings/v3" },
  { base: "/account", v2: "/account/v2", v3: "/account/v3" },
  { base: "/changelog", v2: "/changelog/v2", v3: "/changelog/v3" },
];

export function readSiteVersion(cookieValue: string | undefined): SiteVersion {
  return cookieValue === "v3" ? "v3" : "v2";
}

// The path THIS request should be on for the chosen version, or null when the path isn't a versioned
// page (detail pages, sub-routes, APIs — left untouched). v1 is never a target: the base path always
// resolves to v2 (or v3). A family without a v3 route falls back to v2 in v3 mode.
export function resolveVersionedPath(pathname: string, version: SiteVersion): string | null {
  for (const f of FAMILIES) {
    if (pathname === f.base || pathname === f.v2 || (f.v3 && pathname === f.v3)) {
      return version === "v3" ? f.v3 ?? f.v2 : f.v2;
    }
  }
  return null;
}

// The counterpart path for the OTHER version, used by the client toggle to jump the current page in
// place when it flips the cookie. Returns null when the current page has no distinct counterpart.
export function counterpartPath(pathname: string, nextVersion: SiteVersion): string | null {
  const target = resolveVersionedPath(pathname, nextVersion);
  return target && target !== pathname ? target : null;
}
