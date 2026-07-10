// POST /api/clients/:slug/m365-licenses { licenses: LicenseEntry[] } — set the M365 onboarding
// license(s) for a client (config.onboard.licenses). An entry is a name string (direct assignment)
// or { name, assignVia: 'group', group, groupSource } (licensed via group membership — see
// lib/m365/license-config). The executor reads this, NOT the runbook doc — so this is how you
// actually change which license new users get. Re-plan open cases to apply to existing ones.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/auth/audit";
import { parseLicenseEntries, isGroupBased } from "@/lib/m365/license-config";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const g = await guard("client.edit_systems"); if (g.res) return g.res;

  let body: { licenses?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 422 }); }
  const parsed = parseLicenseEntries(body.licenses);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 422 });
  const licenses = parsed.licenses;

  const sys = await db.clientSystem.findFirst({ where: { client: { slug: params.slug }, systemKey: "m365" }, select: { id: true, config: true, clientId: true } });
  if (!sys) return NextResponse.json({ error: "this client has no m365 system" }, { status: 404 });

  // Server-side gate (the UI hides the option, but that's not the boundary): an ad-source license
  // group is executed by the client's active-directory job — without one it would be silently
  // dropped at plan time and the user onboarded unlicensed while everything reads green.
  if (licenses.some((l) => isGroupBased(l) && l.groupSource === "ad")) {
    const hasAd = await db.clientSystem.count({ where: { clientId: sys.clientId, systemKey: "active-directory" } });
    if (hasAd === 0) {
      return NextResponse.json({ error: "an AD-source license group needs an active-directory system on this client — use an Entra group, or add the AD system first" }, { status: 422 });
    }
  }

  const config = { ...((sys.config ?? {}) as Record<string, unknown>) };
  config.onboard = { ...((config.onboard ?? {}) as Record<string, unknown>), licenses };
  await db.clientSystem.update({ where: { id: sys.id }, data: { config: config as Prisma.InputJsonValue } });
  await recordAudit("client.m365_licenses.set", { user: g.user, clientId: sys.clientId, detail: { licenses } });

  return NextResponse.json({ ok: true, licenses });
}
