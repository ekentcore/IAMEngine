// POST /api/admin/prs/merge { number } — merge one PR through the host checkout's scripts/prs.sh
// (settings.manage). The script does everything the terminal flow does: catches the branch up to
// main, squash-merges, deletes the branch, fast-forwards local main + npm install, retires finished
// worktrees. Audited on request and on completion; the full script output goes back to the dialog.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { recordAudit } from "@/lib/auth/audit";
import { prsAvailable, mergePr } from "@/lib/prs/local-prs";

export const dynamic = "force-dynamic";
// The merge shells out for up to 10 minutes (branch sync + npm install are the slow parts).
export const maxDuration = 660;

export async function POST(req: Request) {
  const g = await guard("settings.manage");
  if (g.res) return g.res;
  if (!(await prsAvailable())) {
    return NextResponse.json({ error: "not available on this host (no repo checkout / gh)" }, { status: 409 });
  }
  const body = (await req.json().catch(() => ({}))) as { number?: unknown };
  const number = typeof body.number === "number" && Number.isInteger(body.number) && body.number > 0 ? body.number : null;
  if (!number) return NextResponse.json({ error: "pass the PR number to merge" }, { status: 422 });

  await recordAudit("pr.merge.requested", { user: g.user, detail: { number } });
  const res = await mergePr(number);
  await recordAudit("pr.merge.finished", { user: g.user, detail: { number, ok: res.ok, exitCode: res.exitCode } });
  return NextResponse.json({ ok: res.ok, exitCode: res.exitCode, output: res.output });
}
