// POST /api/cases/:id/replan — re-pull the latest UM + re-derive identity + re-plan against the
// client's current systems, replacing the planned jobs. Pre-execution only.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { replanCase } from "@/lib/cases/replan-service";
import { SnGatewayError } from "@/lib/servicenow/gateway";
import { normalizeDomainInput } from "@/lib/clients/email-domain";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  let override: string | undefined;
  try {
    const body = (await req.json()) as { emailDomain?: string };
    if (typeof body?.emailDomain === "string" && body.emailDomain.trim() !== "") {
      if (!normalizeDomainInput(body.emailDomain)) {
        return NextResponse.json({ error: "emailDomain must be a domain like acme.com" }, { status: 422 });
      }
      override = body.emailDomain;
    }
  } catch {
    // no body / not JSON — re-plan without an override
  }
  try {
    const res = await replanCase(db, params.id, "ui", override);
    if (!res.ok) {
      const status = res.code === "not_found" ? 404 : 409;
      return NextResponse.json({ error: res.error, code: res.code }, { status });
    }
    return NextResponse.json(res);
  } catch (e) {
    const msg = e instanceof SnGatewayError ? `ServiceNow: ${e.message}` : (e as Error).message;
    return NextResponse.json({ error: `re-plan failed: ${msg}` }, { status: 502 });
  }
}
