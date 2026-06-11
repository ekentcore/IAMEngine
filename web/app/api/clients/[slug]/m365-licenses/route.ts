// POST /api/clients/:slug/m365-licenses { licenses: string[] } — set the M365 onboarding license(s)
// for a client (config.onboard.licenses). The executor reads this, NOT the runbook doc — so this is
// how you actually change which license new users get. Re-plan open cases to apply to existing ones.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/auth/audit";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const g = await guard("client.edit_systems"); if (g.res) return g.res;

  let body: { licenses?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 422 }); }
  if (!Array.isArray(body.licenses)) return NextResponse.json({ error: "licenses must be an array of names" }, { status: 422 });
  const licenses = [...new Set(body.licenses.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()))];

  const sys = await db.clientSystem.findFirst({ where: { client: { slug: params.slug }, systemKey: "m365" }, select: { id: true, config: true, clientId: true } });
  if (!sys) return NextResponse.json({ error: "this client has no m365 system" }, { status: 404 });

  const config = { ...((sys.config ?? {}) as Record<string, unknown>) };
  config.onboard = { ...((config.onboard ?? {}) as Record<string, unknown>), licenses };
  await db.clientSystem.update({ where: { id: sys.id }, data: { config: config as Prisma.InputJsonValue } });
  await recordAudit("client.m365_licenses.set", { user: g.user, clientId: sys.clientId, detail: { licenses } });

  return NextResponse.json({ ok: true, licenses });
}
