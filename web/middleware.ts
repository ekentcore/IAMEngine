// Three classes of request, all decided at the edge (no DB):
//   1. RUNNER API — the machine endpoints the runner/installer call: /api/agents/*, /api/jobs/claim,
//      and /api/jobs/<id>/{credential,result,progress}. Bearer-gated (fail-open if RUNNER_API_TOKEN
//      is unset). These BYPASS the operator session gate (runners have no cookie).
//   2. RUNNER DOWNLOADS — /api/runner/* (bundle manifest/file, one-line installer). Open, bypasses
//      the operator gate so a runner can install/self-update without a session.
//   3. OPERATOR SURFACE — everything else (pages + the operator API, incl. the job-action routes
//      approve/rerun/procurement/complete). When AUTH_ENABLED, require a session cookie's PRESENCE;
//      validity + per-permission checks happen server-side. x-pathname is forwarded so the layout
//      can skip enforcement on /login.
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PUBLIC = ["/login", "/api/auth"];
const SESSION_COOKIE = "iam_session";

function isRunnerApi(p: string): boolean {
  return (
    p === "/api/agents" || p.startsWith("/api/agents/") ||
    p === "/api/jobs/claim" ||
    /^\/api\/jobs\/[^/]+\/(credential|result|progress)$/.test(p)
  );
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (isRunnerApi(pathname)) {
    const token = process.env.RUNNER_API_TOKEN;
    if (!token) return NextResponse.next();
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
  if (process.env.AUTH_ENABLED !== "true") return pass();
  if (PUBLIC.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return pass();

  if (req.cookies.get(SESSION_COOKIE)?.value) return pass();

  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(pathname)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
