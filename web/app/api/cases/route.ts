// GET  /api/cases  — list cases.
// POST /api/cases  — create a case from a manual intake payload, then plan it into jobs.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import type { Action } from "@prisma/client";
import { db } from "@/lib/db";
import { makeCaseRepository } from "@/lib/cases/repository";
import { createAndPlanCase } from "@/lib/cases/planning-service";

export const dynamic = "force-dynamic";

export async function GET() {
  const repo = makeCaseRepository(db);
  return NextResponse.json(await repo.listCases());
}

export async function POST(req: Request) {
  const _g = await guard("case.import"); if (_g.res) return _g.res;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }

  const clientSlug = typeof body.clientSlug === "string" ? body.clientSlug : "";
  const action = body.action === "onboard" || body.action === "offboard" ? (body.action as Action) : null;
  const payload = (body.payload && typeof body.payload === "object" ? body.payload : {}) as Record<string, unknown>;
  if (!clientSlug || !action) {
    return NextResponse.json({ error: "clientSlug and action (onboard|offboard) are required" }, { status: 422 });
  }

  try {
    const outcome = await createAndPlanCase(
      makeCaseRepository(db),
      {
        clientSlug,
        action,
        subject: typeof body.subject === "string" ? body.subject : null,
        serviceNowCaseNumber: typeof body.serviceNowCaseNumber === "string" ? body.serviceNowCaseNumber : null,
        payload,
        dryRun: body.dryRun === true,
      },
      "ui:new-case"
    );
    return NextResponse.json(outcome, { status: 201 });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const status = reason.startsWith("client not found") ? 404 : 500;
    return NextResponse.json({ error: reason }, { status });
  }
}
