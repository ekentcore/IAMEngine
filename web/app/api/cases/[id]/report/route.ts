// GET /api/cases/:id/report — the after-action run report for a case.
// JSON by default (the UI polls this while a case runs); ?format=md returns a downloadable
// markdown document to attach to the case.
import { NextResponse } from "next/server";
import { guardAuth } from "@/lib/auth/route-guard";
import { db } from "@/lib/db";
import { loadRunReport, renderRunReportMarkdown } from "@/lib/cases/run-report";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const _g = await guardAuth(); if (_g.res) return _g.res;
  const rr = await loadRunReport(db, params.id);
  if (!rr) return NextResponse.json({ error: "not found" }, { status: 404 });

  const format = new URL(req.url).searchParams.get("format");
  if (format === "md") {
    return new NextResponse(renderRunReportMarkdown(rr), {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="run-report-${rr.caseNumber ?? rr.caseId}.md"`,
      },
    });
  }
  return NextResponse.json(rr);
}
