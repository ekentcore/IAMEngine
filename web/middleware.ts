// Three classes of request, all decided at the edge (no DB):
//   1. RUNNER API — the machine endpoints the runner/installer call: /api/agents/*, /api/jobs/claim,
//      and /api/jobs/<id>/{credential,result,progress}. Bearer-gated; when RUNNER_API_TOKEN is unset
//      it fails CLOSED in production (or when RUNNER_AUTH_REQUIRED=true) and open in dev/tunnel.
//      These BYPASS the operator session gate (runners have no cookie).
//      Also covers the machine routes under /api/runner/ (conn-test credential broker, cloud-group
//      claim) — those return resolved Delinea secret values and MUST carry the bearer.
//   2. RUNNER BOOTSTRAP — the short allowlist in lib/auth/runner-paths (bundle manifest/file, the
//      one-line installer, troubleshoot). Open by necessity: a host with no token yet has to fetch
//      these to install and self-update. This is an allowlist, NOT the /api/runner/ prefix.
//   3. OPERATOR SURFACE — everything else (pages + the operator API, incl. the job-action routes
//      approve/rerun/procurement/complete). When AUTH_ENABLED, require a session cookie's PRESENCE;
//      validity + per-permission checks happen server-side. x-pathname is forwarded so the layout
//      can skip enforcement on /login. EXCEPTION: the destructive-approval routes (job approve, AD
//      hard-match) fail CLOSED when AUTH_ENABLED is off — see isDestructiveApproval.
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { V2_COOKIE, V2_ROUTES, V2_CANONICAL } from "./lib/v2";
import { isRunnerApi, isRunnerBootstrap, isSecretBearing, isDestructiveApproval } from "./lib/auth/runner-paths";

const PUBLIC = ["/login", "/api/auth"];
const SESSION_COOKIE = "iam_session";

// Site-wide Version 2: when the cookie is on, route a canonical page to its /v2 variant; when off,
// route a /v2 page back to canonical. EXACT-match only (detail pages + v2 subpages pass through).
function v2Redirect(req: NextRequest, pathname: string): NextResponse | null {
  if (req.method !== "GET") return null;
  const on = req.cookies.get(V2_COOKIE)?.value === "on";
  const target = on ? V2_ROUTES[pathname] : V2_CANONICAL[pathname];
  if (!target) return null;
  const url = req.nextUrl.clone();
  url.pathname = target;
  return NextResponse.redirect(url);
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (isRunnerApi(pathname)) {
    const token = process.env.RUNNER_API_TOKEN;
    if (!token) {
      // Fail-CLOSED in prod (or when explicitly required) — a missing token is a misconfiguration.
      // ALSO fail closed, in every environment, for the routes that return resolved Delinea secret
      // VALUES: "no token configured" must never mean "serve tenant-admin credentials to an
      // unauthenticated caller". A dev/tunnel box is exactly where this used to be wide open.
      const required = process.env.NODE_ENV === "production" || process.env.RUNNER_AUTH_REQUIRED === "true";
      if (required || isSecretBearing(pathname)) {
        return NextResponse.json({ error: "runner auth not configured" }, { status: 503 });
      }
      return NextResponse.next();
    }
    const auth = req.headers.get("authorization") ?? "";
    if (!auth.startsWith("Bearer ") || auth.slice(7) !== token) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return NextResponse.next();
  }

  const headers = new Headers(req.headers);
  headers.set("x-pathname", pathname);
  const pass = () => NextResponse.next({ request: { headers } });

  // Liveness probe — public by design: the self-heal watchdog and the in-page restart modal need an
  // endpoint that PROVES route code executes. Gating it here would make the middleware answer for a
  // broken app (the /api/health 401 problem). It exposes liveness + one DB-reachability bit only.
  if (pathname === "/api/health/probe") return NextResponse.next();
  if (isRunnerBootstrap(pathname)) return pass(); // runner bundle download / installer — open by necessity (no token yet)
  if (pathname === "/api/agents" && req.method === "POST") return pass(); // agent enrollment — gated in-handler by the enroll token (no operator cookie / no bearer)
  if (process.env.AUTH_ENABLED !== "true") {
    // Destructive approvals fail CLOSED while operator auth is off. With auth off, guard() passes
    // every caller through as a synthetic system admin — so these routes would let anyone on the
    // network release a destructive offboard step under a fabricated approver name. An approval whose
    // approver can't be authenticated is not an approval.
    if (isDestructiveApproval(pathname)) {
      return NextResponse.json(
        { error: "operator auth is not enabled — a destructive approval needs an authenticated approver. Set AUTH_ENABLED=true." },
        { status: 503 },
      );
    }
    return v2Redirect(req, pathname) ?? pass();
  }
  if (PUBLIC.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return pass();

  if (req.cookies.get(SESSION_COOKIE)?.value) return v2Redirect(req, pathname) ?? pass();

  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(pathname)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
