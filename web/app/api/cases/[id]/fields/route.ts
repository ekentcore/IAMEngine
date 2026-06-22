// PATCH /api/cases/:id/fields { fields: { <field>: <value> } } — fill in the "Needs Information"
// fields the intake couldn't determine. Merges into the case payload (which the runner reads at
// claim time, so no re-plan needed), drops the filled keys from payload.unknownFields, and releases
// the hold once nothing's left to fill.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { caseInScope } from "@/lib/auth/client-scope";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { makeCaseRepository } from "@/lib/cases/repository";
import { recordAudit } from "@/lib/auth/audit";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const g = await guard("case.dispatch"); if (g.res) return g.res;
  if (!(await caseInScope(db, params.id))) return NextResponse.json({ error: "not found" }, { status: 404 });

  let body: { fields?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 422 }); }
  const fields = body.fields && typeof body.fields === "object" ? (body.fields as Record<string, unknown>) : {};

  const c = await db.caseRequest.findUnique({ where: { id: params.id }, select: { payload: true, pausedReason: true } });
  if (!c) return NextResponse.json({ error: "case not found" }, { status: 404 });

  const payload = { ...((c.payload ?? {}) as Record<string, unknown>) };
  const unknown = Array.isArray(payload.unknownFields) ? (payload.unknownFields as { field: string }[]) : [];

  // Every key the operator submitted is "touched" (written, even to blank — clearing a wrong value
  // must take effect); "filled" = non-empty (these release an unknown and re-derive UPN siblings).
  const touched: string[] = [];
  const filled: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    const val = typeof v === "string" ? v.trim() : v;
    payload[k] = val;
    touched.push(k);
    if (typeof val === "string" ? val !== "" : val != null) filled.push(k);
  }
  // Editing the UPN must keep its siblings consistent (deriveIdentity computed them together) — the
  // AD lane reads samAccountName independently, so leaving it stale creates an account that doesn't
  // match the new UPN. Re-derive the local-part-based fields from the new UPN.
  if (filled.includes("userPrincipalName") && typeof payload.userPrincipalName === "string") {
    const upn = payload.userPrincipalName;
    const local = upn.split("@")[0] ?? upn;
    payload.samAccountName = local.slice(0, 20); // AD samAccountName max length
    payload.mailNickname = local;
    payload.workEmail = upn;
  }
  const remaining = unknown.filter((u) => !filled.includes(u.field));
  payload.unknownFields = remaining;
  if (filled.includes("usageLocation")) payload.usageLocationDerived = true;
  // Mark every operator-edited field as such (for the review provenance badge) and drop its stale
  // "AI-filled" note — a hand-entered value is no longer machine-derived.
  const fieldSource = { ...((payload.fieldSource ?? {}) as Record<string, string>) };
  for (const k of touched) fieldSource[k] = "operator";
  payload.fieldSource = fieldSource;
  if (payload.aiResolved && typeof payload.aiResolved === "object") {
    const ai = { ...(payload.aiResolved as Record<string, string>) };
    for (const k of touched) delete ai[k];
    payload.aiResolved = Object.keys(ai).length ? ai : undefined;
  }

  await db.caseRequest.update({ where: { id: params.id }, data: { payload: payload as Prisma.InputJsonValue } });

  // Release the "needs_info" hold once everything's provided.
  if (c.pausedReason === "needs_info" && remaining.length === 0) {
    await makeCaseRepository(db).setHold(params.id, null);
  }
  await recordAudit("case.fields.filled", { user: g.user, caseRequestId: params.id, detail: { filled, remaining: remaining.length } });

  return NextResponse.json({ ok: true, filled, remaining: remaining.length, released: c.pausedReason === "needs_info" && remaining.length === 0 });
}
