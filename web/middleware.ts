// Interim transport auth for the runner-facing API. The production design is mutual TLS +
// a signed per-job token (docs/ARCHITECTURE.md); until that exists, require a shared bearer
// token so the credential-brokering / job-claiming surface is not anonymous.
//
// Fail-closed ONLY when configured: if RUNNER_API_TOKEN is set, every /api/agents and
// /api/jobs request must present `Authorization: Bearer <token>`. If it is unset (local dev),
// requests pass — set RUNNER_API_TOKEN in any shared/staging/prod environment.
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(req: NextRequest) {
  const token = process.env.RUNNER_API_TOKEN;
  if (!token) return NextResponse.next();
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ") || auth.slice(7) !== token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.next();
}

export const config = { matcher: ["/api/agents/:path*", "/api/jobs/:path*"] };
