// POST /api/clients/:slug/m365-password { mode, value?, secretName? } — how new users' INITIAL
// password is set on M365 onboarding:
//   generate — a policy-compliant random password (default; clears any override)
//   fixed    — a literal default (e.g. from the KB) stored in config.onboard.initialPassword
//   secret   — a Delinea Secret Server reference: brokered like any credential at dispatch (added to
//              the m365 system's secretNames; the operator wires its Delinea id in the Secrets panel)
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/auth/audit";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const g = await guard("client.edit_secrets"); if (g.res) return g.res;

  let body: { mode?: unknown; value?: unknown; secretName?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 422 }); }
  const mode = body.mode === "fixed" || body.mode === "secret" ? body.mode : "generate";

  const sys = await db.clientSystem.findFirst({ where: { client: { slug: params.slug }, systemKey: "m365" }, select: { id: true, config: true, secretNames: true, clientId: true } });
  if (!sys) return NextResponse.json({ error: "this client has no m365 system" }, { status: 404 });

  const config = { ...((sys.config ?? {}) as Record<string, unknown>) };
  const onboard = { ...((config.onboard ?? {}) as Record<string, unknown>) };
  let secretNames = sys.secretNames;

  if (mode === "fixed") {
    const value = typeof body.value === "string" ? body.value : "";
    if (value.length < 8) return NextResponse.json({ error: "the default password must be at least 8 characters" }, { status: 422 });
    onboard.initialPassword = value;
    delete onboard.initialPasswordSecret;
  } else if (mode === "secret") {
    const name = typeof body.secretName === "string" ? body.secretName.trim() : "";
    if (!name) return NextResponse.json({ error: "enter the secret name to broker (wire its Delinea id in the Secrets panel)" }, { status: 422 });
    onboard.initialPasswordSecret = name;
    delete onboard.initialPassword;
    if (!secretNames.includes(name)) secretNames = [...secretNames, name];
  } else {
    delete onboard.initialPassword;
    delete onboard.initialPasswordSecret;
  }
  config.onboard = onboard;
  await db.clientSystem.update({ where: { id: sys.id }, data: { config: config as Prisma.InputJsonValue, secretNames } });
  await recordAudit("client.m365_password.set", { user: g.user, clientId: sys.clientId, detail: { mode, secretName: mode === "secret" ? body.secretName : undefined } });

  return NextResponse.json({ ok: true, mode });
}
