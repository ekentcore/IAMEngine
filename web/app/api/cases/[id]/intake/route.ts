// GET /api/cases/:id/intake — the full intake form for the case's UM: every field the requester
// filled in (with readable values) + the blanks. Loaded lazily by the case page so a slow/down
// ServiceNow can't block the render.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { snConfigFromEnv } from "@/lib/servicenow/gateway";
import { fetchIntakeFields } from "@/lib/servicenow/intake-fields";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const c = await db.caseRequest.findUnique({ where: { id: params.id }, select: { serviceNowCaseNumber: true } });
  if (!c) return NextResponse.json({ error: "case not found" }, { status: 404 });
  if (!c.serviceNowCaseNumber) return NextResponse.json({ error: "no ServiceNow ticket for this case" }, { status: 404 });

  try {
    const breakdown = await fetchIntakeFields(snConfigFromEnv(), c.serviceNowCaseNumber);
    if (!breakdown) return NextResponse.json({ error: "no ServiceNow record" }, { status: 404 });
    return NextResponse.json(breakdown);
  } catch (e) {
    return NextResponse.json({ error: `could not load intake (check SN env): ${(e as Error).message}` }, { status: 502 });
  }
}
