// GET /api/admin/prs — outstanding PRs for the Merge-PRs dialog (settings.manage). Reads the host
// checkout via `gh`; { available: false } when this host has no repo/gh (e.g. Azure), which the UI
// treats as "feature doesn't exist here".
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { prsAvailable, listOpenPrs } from "@/lib/prs/local-prs";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await guard("settings.manage");
  if (g.res) return g.res;
  if (!(await prsAvailable())) return NextResponse.json({ available: false, prs: [] });
  try {
    const prs = await listOpenPrs();
    return NextResponse.json({ available: true, prs });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "gh pr list failed" }, { status: 502 });
  }
}
