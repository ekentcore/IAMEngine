// POST /api/admin/agent-migration — set the global agent app-URL migration target { enabled, targetUrl }.
// The heartbeat reads this to tell agents to move to the new URL. Guarded by settings.manage.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { recordAudit } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { getAppSetting, setAppSetting } from "@/lib/settings";
import { AGENT_MIGRATION_KEY, nextMigrationSetting, type AgentMigrationSetting } from "@/lib/jobs/agent-migration";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const g = await guard("settings.manage");
  if (g.res) return g.res;
  const body = (await req.json().catch(() => ({}))) as { enabled?: unknown; targetUrl?: unknown };
  const enabled = Boolean(body.enabled);
  const targetUrl = typeof body.targetUrl === "string" ? body.targetUrl.trim() : "";
  // A non-empty target must be an absolute http(s) URL — a bad value would strand agents that trust it.
  if (targetUrl) {
    let ok = false;
    try {
      const u = new URL(targetUrl);
      ok = u.protocol === "http:" || u.protocol === "https:";
    } catch {
      ok = false;
    }
    if (!ok) return NextResponse.json({ error: "targetUrl must be an absolute http(s) URL" }, { status: 422 });
  }
  if (enabled && !targetUrl) return NextResponse.json({ error: "set a target URL before enabling fleet migration" }, { status: 422 });
  // A settings-form save must not silently orphan a pending "prove it on one agent" flow: the proof
  // pointer survives only while the target it was proving is still the target (see nextMigrationSetting).
  const existing = await getAppSetting<AgentMigrationSetting>(db, AGENT_MIGRATION_KEY);
  const next = nextMigrationSetting(existing, { enabled, targetUrl });
  await setAppSetting(db, AGENT_MIGRATION_KEY, next);
  await recordAudit("agent.migration.configure", { user: g.user, detail: { ...next, via: "settings" } });
  return NextResponse.json({ ok: true, enabled, targetUrl });
}
