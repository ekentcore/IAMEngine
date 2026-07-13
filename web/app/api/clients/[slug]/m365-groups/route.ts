// POST /api/clients/:slug/m365-groups { groups: [{ name, type? }] } — set the M365 onboarding groups
// for a client (config.onboard.groups). type is an optional hint from the KB: dl | security | m365 |
// unsure (the runner verifies the real type in Entra and narrates it). The executor reads this — NOT
// the runbook doc — so this is how new users actually get added to groups.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { clientSlugInScope } from "@/lib/auth/client-scope";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/auth/audit";

export const dynamic = "force-dynamic";

const TYPES = new Set(["dl", "security", "m365", "unsure"]);

export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const g = await guard("client.edit_systems"); if (g.res) return g.res;
  // scope-gated: an out-of-scope client reads as not-found (see clientSlugInScope).
  if (!(await clientSlugInScope(db, params.slug))) return NextResponse.json({ error: "not found" }, { status: 404 });
  let body: { groups?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 422 }); }
  if (!Array.isArray(body.groups)) return NextResponse.json({ error: "groups must be an array" }, { status: 422 });

  const groups = body.groups
    .map((x) => x as { name?: unknown; type?: unknown })
    .map((x) => ({ name: typeof x.name === "string" ? x.name.trim() : "", type: typeof x.type === "string" && TYPES.has(x.type) && x.type !== "unsure" ? x.type : undefined }))
    .filter((x) => x.name)
    .map((x) => (x.type ? { name: x.name, type: x.type } : { name: x.name }));

  const sys = await db.clientSystem.findFirst({ where: { client: { slug: params.slug }, systemKey: "m365" }, select: { id: true, config: true, clientId: true } });
  if (!sys) return NextResponse.json({ error: "this client has no m365 system" }, { status: 404 });

  const config = { ...((sys.config ?? {}) as Record<string, unknown>) };
  config.onboard = { ...((config.onboard ?? {}) as Record<string, unknown>), groups };
  await db.clientSystem.update({ where: { id: sys.id }, data: { config: config as Prisma.InputJsonValue } });
  await recordAudit("client.m365_groups.set", { user: g.user, clientId: sys.clientId, detail: { count: groups.length } });

  return NextResponse.json({ ok: true, groups });
}
