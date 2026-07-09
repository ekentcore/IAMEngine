// GET /api/jobs — ops summary (job counts by status). The runner endpoints are the
// sub-routes: /api/jobs/claim, /api/jobs/{id}/credential, /api/jobs/{id}/result.
import { NextResponse } from "next/server";
import { guardAuth } from "@/lib/auth/route-guard";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic"; // queries the DB per-request; never static

export async function GET() {
  const _g = await guardAuth(); if (_g.res) return _g.res;
  const rows = await db.job.groupBy({ by: ["status"], _count: { _all: true } });
  const byStatus = Object.fromEntries(rows.map((r) => [r.status, r._count._all]));
  return NextResponse.json({ byStatus });
}
