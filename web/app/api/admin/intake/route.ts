// GET/POST /api/admin/intake — read or toggle the automated ServiceNow intake poller. When enabled,
// heartbeats run it ~every 15 min: pull open/unassigned in-scope UM tickets and auto-import + plan any
// new ones (left HELD for review). Off by default. Guarded to case.import (the manual-import capability).
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { recordAudit } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { getAppSetting, setAppSetting, INTAKE_SETTING_KEY, type IntakeSetting } from "@/lib/settings";
import { runIntakeSweepNow } from "@/lib/jobs/intake-sweep";
import { SnGatewayError } from "@/lib/servicenow/gateway";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await guard("case.import"); if (g.res) return g.res;
  const s = (await getAppSetting<IntakeSetting>(db, INTAKE_SETTING_KEY)) ?? { enabled: false };
  return NextResponse.json(s);
}

export async function POST(req: Request) {
  const g = await guard("case.import"); if (g.res) return g.res;
  let body: { enabled?: unknown; action?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 422 }); }

  // "Import now" — run the same sweep immediately, ignoring the ~15-min throttle and the enabled flag
  // (an explicit operator action). Returns the run summary for UI feedback.
  if (body.action === "import-now") {
    try {
      const result = await runIntakeSweepNow(db, `ui:import-now:${g.user?.email ?? "operator"}`);
      await recordAudit("intake.import_now", { user: g.user, detail: result });
      const setting = (await getAppSetting<IntakeSetting>(db, INTAKE_SETTING_KEY)) ?? { enabled: false };
      return NextResponse.json({ ok: true, ...result, setting });
    } catch (e) {
      const msg = e instanceof SnGatewayError ? `ServiceNow: ${e.message}` : (e as Error).message;
      return NextResponse.json({ error: `import failed: ${msg}` }, { status: 502 });
    }
  }

  const enabled = Boolean(body.enabled);
  const prev = (await getAppSetting<IntakeSetting>(db, INTAKE_SETTING_KEY)) ?? { enabled: false };
  await setAppSetting(db, INTAKE_SETTING_KEY, { ...prev, enabled });
  await recordAudit(enabled ? "intake.poll.enabled" : "intake.poll.disabled", { user: g.user });
  return NextResponse.json({ ok: true, enabled });
}
