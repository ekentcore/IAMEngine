// PATCH /api/clients/:slug/universal-choices/:id { m365Groups?, googleGroups? } — map one Universal
// Choice to the groups a hire who picks it gets. A list replaces the old one; [] clears it.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { clientSlugInScope } from "@/lib/auth/client-scope";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/auth/audit";
import { normalizeGroupList } from "@/lib/clients/universal-choices";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: { slug: string; id: string } }) {
  const g = await guard("client.edit_systems"); if (g.res) return g.res;
  if (!(await clientSlugInScope(db, params.slug))) return NextResponse.json({ error: "not found" }, { status: 404 });
  let body: { m365Groups?: unknown; googleGroups?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 422 }); }

  const data: { m365Groups?: string[]; googleGroups?: string[] } = {};
  for (const key of ["m365Groups", "googleGroups"] as const) {
    if (body[key] === undefined) continue;
    const n = normalizeGroupList(body[key]);
    if (!n.ok) return NextResponse.json({ error: `${key === "m365Groups" ? "Microsoft 365" : "Google"} groups: ${n.error}` }, { status: 422 });
    data[key] = n.value;
  }
  if (!Object.keys(data).length) return NextResponse.json({ error: "nothing to update" }, { status: 422 });

  // Scoped by slug as well as id: a choice id from another client must not be writable through this one.
  const row = await db.universalChoice.findFirst({ where: { id: params.id, client: { slug: params.slug } }, select: { id: true, clientId: true, question: true, label: true } });
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  const saved = await db.universalChoice.update({
    where: { id: row.id }, data,
    select: { id: true, question: true, label: true, value: true, m365Groups: true, googleGroups: true, syncedAt: true, goneAt: true },
  });
  await recordAudit("client.universal_choices.map", { user: g.user, clientId: row.clientId, detail: { question: row.question, label: row.label, ...data } });
  return NextResponse.json({ ok: true, choice: saved });
}
