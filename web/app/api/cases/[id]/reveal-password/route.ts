// POST /api/cases/:id/reveal-password — reveal the generated initial password EXACTLY ONCE, then wipe
// it. The value is never logged (the audit records the reveal, not the password). 404 once it's gone.
// Gated by case.dispatch: handing over the initial credential is part of EXECUTING the onboard, so it
// belongs to the roles that run/verify the case — not to read-only roles (auditor/importer) or
// impersonated sessions, which guardAuth would admit. This both discloses a live credential and
// mutates state (consumes the one-time reveal), so it must not sit behind an auth-only guard.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { caseInScope } from "@/lib/auth/client-scope";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const _g = await guard("case.dispatch"); if (_g.res) return _g.res;
  if (!(await caseInScope(db, params.id))) return NextResponse.json({ error: "not found" }, { status: 404 });

  const c = await db.caseRequest.findUnique({ where: { id: params.id }, select: { initialPassword: true } });
  if (!c?.initialPassword) return NextResponse.json({ error: "no initial password to reveal (already shown, or not a generated-password onboard)" }, { status: 404 });

  const password = c.initialPassword;
  await db.caseRequest.update({ where: { id: params.id }, data: { initialPassword: null } }); // shown once → wipe
  await db.auditLog.create({ data: { actor: _g.user.email || "ui", action: "case.password.reveal", caseRequestId: params.id } });
  return NextResponse.json({ password });
}
