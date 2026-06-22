// PATCH /api/cases/:id/m365-override { licenses?, userPrincipalName?, fallbacks? } — per-case M365
// overrides from the dry-run review (when the imported defaults are wrong for this hire): the
// license(s) to assign, the username, and the conflict-fallback username(s). Licenses write the
// m365 job's config; username/fallbacks write the case payload (read by the runner at claim time).
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { caseInScope } from "@/lib/auth/client-scope";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/auth/audit";

export const dynamic = "force-dynamic";

const strArr = (v: unknown): string[] | null =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()))] : null;

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const g = await guard("case.dispatch"); if (g.res) return g.res;
  if (!(await caseInScope(db, params.id))) return NextResponse.json({ error: "not found" }, { status: 404 });

  let body: { licenses?: unknown; userPrincipalName?: unknown; fallbacks?: unknown; usernameCollisionPolicy?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 422 }); }

  const c = await db.caseRequest.findUnique({ where: { id: params.id }, select: { payload: true, jobs: { where: { systemKey: "m365" }, select: { id: true, request: true } } } });
  if (!c) return NextResponse.json({ error: "case not found" }, { status: 404 });

  const payload = { ...((c.payload ?? {}) as Record<string, unknown>) };
  const changed: string[] = [];

  // Operator's answer to an ambiguous same-name account: 'adopt' (it's a re-run of this person) or
  // 'new' (a different person — use a fallback). Written to the m365 job config; the runner reads it.
  if (body.usernameCollisionPolicy === "adopt" || body.usernameCollisionPolicy === "new") {
    for (const j of c.jobs) {
      const reqJson = { ...((j.request ?? {}) as Record<string, unknown>) };
      reqJson.config = { ...((reqJson.config ?? {}) as Record<string, unknown>), usernameCollisionPolicy: body.usernameCollisionPolicy };
      await db.job.update({ where: { id: j.id }, data: { request: reqJson as Prisma.InputJsonValue } });
    }
    changed.push(`collision:${body.usernameCollisionPolicy}`);
  }

  if (typeof body.userPrincipalName === "string" && body.userPrincipalName.trim()) {
    const upn = body.userPrincipalName.trim();
    const local = upn.split("@")[0] ?? upn;
    payload.userPrincipalName = upn;
    payload.samAccountName = local.slice(0, 20);
    payload.mailNickname = local;
    payload.workEmail = upn;
    const fs = { ...((payload.fieldSource ?? {}) as Record<string, string>) }; fs.userPrincipalName = "operator"; payload.fieldSource = fs;
    changed.push("username");
  }
  const fb = strArr(body.fallbacks);
  if (fb) { payload.userPrincipalNameFallbacks = fb.filter((f) => f !== payload.userPrincipalName); changed.push("fallbacks"); }

  const licenses = strArr(body.licenses);
  if (licenses && c.jobs.length) {
    for (const j of c.jobs) {
      const reqJson = { ...((j.request ?? {}) as Record<string, unknown>) };
      reqJson.config = { ...((reqJson.config ?? {}) as Record<string, unknown>), licenses };
      await db.job.update({ where: { id: j.id }, data: { request: reqJson as Prisma.InputJsonValue } });
    }
    changed.push("licenses");
  }

  if (changed.length === 0) return NextResponse.json({ error: "nothing to update" }, { status: 422 });
  await db.caseRequest.update({ where: { id: params.id }, data: { payload: payload as Prisma.InputJsonValue } });
  await recordAudit("case.m365_override", { user: g.user, caseRequestId: params.id, detail: { changed } });
  return NextResponse.json({ ok: true, changed });
}
