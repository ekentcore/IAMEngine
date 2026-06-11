// Two gates, both edge-safe (no DB):
//   1. Runner API (/api/agents, /api/jobs) — the shared bearer the runners already use (mTLS +
//      signed per-job tokens are the production design; docs/ARCHITECTURE.md). Fail-closed only
//      when RUNNER_API_TOKEN is set; unset = local dev passes.
//   2. Operator surface — when AUTH_ENABLED, require a session cookie's PRESENCE (cheap). Real
//      validity (expiry, revocation, role) is enforced server-side in the layout + per-action
//      guards, which run in the Node runtime where Prisma is available. Forwards x-pathname so the
//      layout can skip enforcement on /login.
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const RUNNER_PREFIXES = ["/api/agents", "/api/jobs"];
const PUBLIC = ["/login", "/api/auth"];
const SESSION_COOKIE = "iam_session";

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (RUNNER_PREFIXES.some((p) => pathname.startsWith(p))) {
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
