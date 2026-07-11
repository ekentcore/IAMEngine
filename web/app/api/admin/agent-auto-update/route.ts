// POST /api/admin/agent-auto-update — toggle auto-updating stale agents on heartbeat
// (agent_auto_update app setting). Guarded to settings.manage.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { recordAudit } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { setAppSetting } from "@/lib/settings";
import { AGENT_AUTO_UPDATE_KEY } from "@/lib/jobs/agent-updates";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const g = await guard("settings.manage"); if (g.res) return g.res;
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const enabled = Boolean(body.enabled);
  await setAppSetting(db, AGENT_AUTO_UPDATE_KEY, { enabled });
  await recordAudit("agent.auto_update.toggle", { user: g.user, detail: { enabled } });
  return NextResponse.json({ ok: true, enabled });
}
