// POST /api/cases/:id/default-password — the client's DEFAULT initial password for this onboard, so the
// operator can pass it on to the client (FR #86). Unlike the generate-mode reveal this isn't one-time:
// it's the client's standing default, already stored on the m365 system, and nothing is wiped.
//
// Same gate as the one-time reveal (case.dispatch): handing over a live credential is part of running
// the onboard, not something read-only roles or impersonated sessions get. POST, not GET, so a value
// never lands in a URL, a prefetch or a proxy log; every view is audited (the event, never the value).
// A Delinea-backed default returns only the reference — the app never holds that value.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { recordAudit } from "@/lib/auth/audit";
import { caseInScope } from "@/lib/auth/client-scope";
import { db } from "@/lib/db";
import { clientDefaultPassword } from "@/lib/cases/default-password";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const _g = await guard("case.dispatch"); if (_g.res) return _g.res;
  if (!(await caseInScope(db, params.id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const c = await db.caseRequest.findUnique({ where: { id: params.id }, select: { action: true, clientId: true } });
  if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (c.action !== "onboard") return NextResponse.json({ error: "a default password only applies to onboards" }, { status: 422 });

  const found = await clientDefaultPassword(db, c.clientId);
  if (!found) return NextResponse.json({ error: "this client has no default password — new users get a generated one" }, { status: 404 });

  if (found.pw.mode === "secret") {
    const s = await db.secret.findUnique({ where: { clientId_name: { clientId: found.ownerClientId, name: found.pw.secretName } }, select: { externalId: true } });
    await recordAudit("case.password.default_reference", { user: _g.user, caseRequestId: params.id, clientId: c.clientId, detail: { secretName: found.pw.secretName } });
    return NextResponse.json({ mode: "secret", secretName: found.pw.secretName, delineaId: s?.externalId ?? null });
  }
  await recordAudit("case.password.default_view", { user: _g.user, caseRequestId: params.id, clientId: c.clientId });
  return NextResponse.json({ mode: "fixed", password: found.pw.value });
}
