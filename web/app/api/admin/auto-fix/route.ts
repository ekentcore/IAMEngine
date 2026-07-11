// GET/POST /api/admin/auto-fix — read or flip the "autoFix" app setting: the opt-in auto-trigger
// that hands repeatedly-failing run-log lines to the self-healing fix lane. Guarded to
// settings.manage (global_admin+). The fixer only ever opens DRAFT PRs — a human merges.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { recordAudit } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { getAppSetting, setAppSetting } from "@/lib/settings";
import { AUTO_FIX_SETTING_KEY, type AutoFixSetting } from "@/lib/fixes/fix-tasks";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await guard("settings.manage");
  if (g.res) return g.res;
  const s = await getAppSetting<AutoFixSetting>(db, AUTO_FIX_SETTING_KEY);
  return NextResponse.json({ enabled: s?.enabled === true });
}

export async function POST(req: Request) {
  const g = await guard("settings.manage");
  if (g.res) return g.res;
  let body: { enabled?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }
  const enabled = body.enabled === true;
  await setAppSetting(db, AUTO_FIX_SETTING_KEY, { enabled } satisfies AutoFixSetting);
  await recordAudit("settings.autofix.update", { user: g.user, detail: { enabled } });
  return NextResponse.json({ ok: true, enabled });
}
