// POST /api/cases/import — import + plan a case from a ServiceNow ticket number (UM…).
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { importCaseFromServiceNow } from "@/lib/cases/import-service";
import { SnGatewayError } from "@/lib/servicenow/gateway";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { number?: string; emailDomain?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }
  if (typeof body.number !== "string" || !body.number.trim()) {
    return NextResponse.json({ error: "number is required (e.g. UM0028698)" }, { status: 422 });
  }
  const emailDomainOverride = typeof body.emailDomain === "string" ? body.emailDomain : undefined;

  try {
    const result = await importCaseFromServiceNow(db, body.number, "ui:import", { emailDomainOverride });
    if (!result.ok) {
      const status = result.code === "not_found" || result.code === "no_client" ? 404 : 422;
      return NextResponse.json({ error: result.error }, { status });
    }
    return NextResponse.json(result, { status: result.alreadyImported ? 200 : 201 });
  } catch (err) {
    if (err instanceof SnGatewayError) {
      return NextResponse.json({ error: err.message, statusCode: err.statusCode }, { status: 502 });
    }
    const reason = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: reason }, { status: 500 });
  }
}
