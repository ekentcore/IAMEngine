// POST /api/admin/restart-server — restart the web server from the UI (settings.manage). Only
// works when the process runs under the launchd supervisor (web/scripts/install-web-supervisor.sh
// sets IAM_SUPERVISED=1): the app simply exits after replying, and launchd's KeepAlive brings it
// back — no PID hunting, no shell access needed. Without a supervisor an exit would just take the
// site down, so we refuse.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { recordAudit } from "@/lib/auth/audit";

export const dynamic = "force-dynamic";

export async function POST() {
  const g = await guard("settings.manage");
  if (g.res) return g.res;

  if (process.env.IAM_SUPERVISED !== "1") {
    return NextResponse.json(
      { error: "not running under the supervisor — install it with web/scripts/install-web-supervisor.sh, then Restart works from here" },
      { status: 409 }
    );
  }

  await recordAudit("server.restart", { user: g.user, detail: { via: "settings" } });

  // Reply first, then exit on the next tick so the response flushes; launchd relaunches us.
  setTimeout(() => process.exit(0), 500);
  return NextResponse.json({ ok: true, restarting: true });
}
