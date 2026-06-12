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

  let body: { mode?: unknown; value?: unknown; delineaId?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 422 }); }
  const mode = body.mode === "fixed" || body.mode === "secret" ? body.mode : "generate";

  const sys = await db.clientSystem.findFirst({ where: { client: { slug: params.slug }, systemKey: "m365" }, select: { id: true, config: true, secretNames: true, clientId: true } });
  if (!sys) return NextResponse.json({ error: "this client has no m365 system" }, { status: 404 });

  const config = { ...((sys.config ?? {}) as Record<string, unknown>) };
  const onboard = { ...((config.onboard ?? {}) as Record<string, unknown>) };
  let secretNames = sys.secretNames;
  // The runner auto-detects ANY brokered credential literally named "default-password" as the
  // initial password (Start-IamRunner.ps1 Resolve-CtgInitialPassword). So whenever we are NOT in
  // secret mode we must fully retire it — drop it from secretNames AND delete the Secret row —
  // otherwise it stays wired + brokered and "generate" never randomizes / "fixed" is ignored.
  const PW_SECRET = "default-password";

  if (mode === "secret") {
    // One field: the Delinea secret id/number. We upsert the wiring (a Secret row, name
    // "default-password", externalId = the id) and mark it required so it's brokered — no separate
    // Secrets-panel step. externalId is the Delinea reference, NEVER a value.
    const delineaId = typeof body.delineaId === "string" ? body.delineaId.trim() : "";
    if (!delineaId) return NextResponse.json({ error: "enter the Delinea secret id/number for the default password" }, { status: 422 });
    await db.secret.upsert({
      where: { clientId_name: { clientId: sys.clientId, name: PW_SECRET } },
      create: { clientId: sys.clientId, name: PW_SECRET, provider: "delinea", externalId: delineaId, label: "M365 initial password" },
      update: { externalId: delineaId, provider: "delinea" },
    });
    onboard.initialPasswordSecret = PW_SECRET;
    delete onboard.initialPassword;
    if (!secretNames.includes(PW_SECRET)) secretNames = [...secretNames, PW_SECRET];
  } else {
    // fixed (literal) or generate (random) — retire any prior default-password secret so the runner
    // can't keep using it.
    if (mode === "fixed") {
      const value = typeof body.value === "string" ? body.value : "";
      if (value.length < 8) return NextResponse.json({ error: "the default password must be at least 8 characters" }, { status: 422 });
      onboard.initialPassword = value;
    } else {
      delete onboard.initialPassword;
    }
    delete onboard.initialPasswordSecret;
    secretNames = secretNames.filter((n) => n !== PW_SECRET);
    await db.secret.deleteMany({ where: { clientId: sys.clientId, name: PW_SECRET } });
  }
  config.onboard = onboard;
  await db.clientSystem.update({ where: { id: sys.id }, data: { config: config as Prisma.InputJsonValue, secretNames } });
  await recordAudit("client.m365_password.set", { user: g.user, clientId: sys.clientId, detail: { mode } });

  return NextResponse.json({ ok: true, mode });
}
