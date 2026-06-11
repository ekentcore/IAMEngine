// POST /api/clients/:slug/replan-cases — re-plan every OPEN case of this client against its
// current systems (after a KB refresh / systems edit, so already-imported cases pick up the
// change). Started cases re-plan incrementally; future cases plan fresh at creation anyway.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { db } from "@/lib/db";
import { replanCase } from "@/lib/cases/replan-service";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { id?: string; slug: string } }) {
  const _g = await guard("case.plan"); if (_g.res) return _g.res;
  const client = await db.client.findUnique({ where: { slug: params.slug }, select: { id: true } });
  if (!client) return NextResponse.json({ error: "not found" }, { status: 404 });
  const open = await db.caseRequest.findMany({
    where: { clientId: client.id, deletedAt: null, status: { notIn: ["completed", "failed"] } },
    select: { id: true },
  });
  let full = 0, incremental = 0;
  const errors: string[] = [];
  for (const c of open) {
    try {
      const r = await replanCase(db, c.id, "ui:client-replan");
      if (r.ok) { if (r.mode === "incremental") incremental++; else full++; }
      else errors.push(r.error);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  return NextResponse.json({ ok: errors.length === 0, total: open.length, full, incremental, errors: errors.slice(0, 3) });
}
