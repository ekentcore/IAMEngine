// Three classes of request, all decided at the edge (no DB):
//   1. RUNNER API — the machine endpoints the runner/installer call: /api/agents/*, /api/jobs/claim,
//      and /api/jobs/<id>/{credential,result,progress}. Bearer-gated; when RUNNER_API_TOKEN is unset
//      it fails CLOSED in production (or when RUNNER_AUTH_REQUIRED=true) and open in dev/tunnel.
//      These BYPASS the operator session gate (runners have no cookie).
//   2. RUNNER DOWNLOADS — /api/runner/* (bundle manifest/file, one-line installer). Open, bypasses
//      the operator gate so a runner can install/self-update without a session.
//   3. OPERATOR SURFACE — everything else (pages + the operator API, incl. the job-action routes
//      approve/rerun/procurement/complete). When AUTH_ENABLED, require a session cookie's PRESENCE;
//      validity + per-permission checks happen server-side. x-pathname is forwarded so the layout
//      can skip enforcement on /login.
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { V2_COOKIE, V2_ROUTES, V2_CANONICAL } from "./lib/v2";

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

function isRunnerApi(p: string): boolean {
  // NOTE: /api/agents (exact) is enrollment — NOT bearer-gated here (a brand-new agent has no token
  // yet; it's gated in-handler by the enroll token). Only the /api/agents/* sub-paths (heartbeat,
  // ad-objects, …) are bearer-gated — those are called by already-enrolled agents that carry the token.
  return (
    p.startsWith("/api/agents/") ||
    p === "/api/jobs/claim" ||
    /^\/api\/jobs\/[^/]+\/(credential|result|progress)$/.test(p)
  );
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (isRunnerApi(pathname)) {
    const token = process.env.RUNNER_API_TOKEN;
    if (!token) {
      // Production-gated fail-CLOSED: in prod (or when explicitly required) a missing token is a
      // misconfiguration — refuse rather than serve runner APIs (incl. the Delinea credential broker)
      // unauthenticated. In dev/tunnel it stays fail-open so a local runner works without a token.
      const required = process.env.NODE_ENV === "production" || process.env.RUNNER_AUTH_REQUIRED === "true";
      if (required) return NextResponse.json({ error: "runner auth not configured" }, { status: 503 });
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

  if (pathname.startsWith("/api/runner")) return pass(); // runner bundle download / installer — open
  if (pathname === "/api/agents" && req.method === "POST") return pass(); // agent enrollment — gated in-handler by the enroll token (no operator cookie / no bearer)
  if (process.env.AUTH_ENABLED !== "true") return v2Redirect(req, pathname) ?? pass();
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
