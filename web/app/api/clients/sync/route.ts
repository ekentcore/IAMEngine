// POST /api/clients/sync — manual "Refresh from ServiceNow". Pulls the in-scope roster
// and reconciles it into the Client table. See docs/DATA_MODEL.md.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { runSnSync } from "@/lib/clients/sync-runner";
import { SnGatewayError } from "@/lib/servicenow/gateway";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const result = await runSnSync(db, "ui:refresh");
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof SnGatewayError) {
      return NextResponse.json(
        { error: err.message, statusCode: err.statusCode },
        { status: 502 }
      );
    }
    const reason = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: reason }, { status: 500 });
  }
}
