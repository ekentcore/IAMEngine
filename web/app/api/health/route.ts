// GET /api/health — run every integration health check (configured + reachable) and return the
// results. Used by the /health page. Never throws: a failing check is reported, not 500'd.
import { NextResponse } from "next/server";
import { guardAuth } from "@/lib/auth/route-guard";
import { runHealthChecks } from "@/lib/health/checks";

export const dynamic = "force-dynamic";
// Health checks must hit the real services every time — opt every fetch() in this route out of
// Next's fetch cache, or a service that went down after the first call would still show "ok".
export const fetchCache = "force-no-store";

export async function GET() {
  const _g = await guardAuth(); if (_g.res) return _g.res;
  const checks = await runHealthChecks();
  const anyFail = checks.some((c) => c.status === "fail");
  return NextResponse.json({ at: new Date().toISOString(), checks }, { status: anyFail ? 503 : 200 });
}
