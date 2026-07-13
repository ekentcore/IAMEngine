// PATCH /api/cases/:id/email-domain — pick which of the client's email domains THIS case onboards
// under (multi-domain clients), then re-plan immediately so the payload identity + jobs rebuild.
// { domain: null } clears back to the client default. Gated like the other pre-run knobs that
// change what will execute (case.dispatch). The domain must be one the client actually offers —
// a typo must not mint an unverified UPN suffix.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { db } from "@/lib/db";
import { normalizeDomainInput } from "@/lib/clients/email-domain";
import { replanCase } from "@/lib/cases/replan-service";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const _g = await guard("case.dispatch"); if (_g.res) return _g.res;
  let body: { domain?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 422 }); }

  const c = await db.caseRequest.findUnique({
    where: { id: params.id },
    select: { id: true, action: true, client: { select: { id: true, domains: true, emailDomain: true, primaryDomain: true } } },
  });
  if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (c.action !== "onboard") return NextResponse.json({ error: "the email domain only applies to onboarding cases" }, { status: 422 });

  let domain: string | null = null;
  if (body.domain !== null && body.domain !== undefined && body.domain !== "") {
    domain = normalizeDomainInput(typeof body.domain === "string" ? body.domain : "");
    if (!domain) return NextResponse.json({ error: "not a valid domain" }, { status: 422 });
    const offered = new Set([...(c.client.domains ?? []), c.client.emailDomain, c.client.primaryDomain].filter(Boolean).map((d) => (d as string).toLowerCase()));
    if (!offered.has(domain)) return NextResponse.json({ error: `${domain} is not one of this client's email domains — add it on the client page first` }, { status: 422 });
  }

  await db.caseRequest.update({ where: { id: c.id }, data: { emailDomainOverride: domain } });
  await db.auditLog.create({ data: { actor: "ui", action: "case.email_domain.set", caseRequestId: c.id, clientId: c.client.id, detail: { domain } } });

  // Apply immediately: replan re-derives the payload identity with the persisted override (or the
  // default when cleared) and rebuilds the planned jobs. Uses replan's own started/finished guards.
  try {
    const res = await replanCase(db, c.id, "ui");
    return NextResponse.json({ ok: true, domain, replanned: res });
  } catch (e) {
    return NextResponse.json({ error: `domain saved but re-plan failed: ${(e as Error).message}` }, { status: 409 });
  }
}
