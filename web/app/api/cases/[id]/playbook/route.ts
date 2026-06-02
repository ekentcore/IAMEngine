// GET /api/cases/:id/playbook — the pre-flight dry-run playbook for a planned case.
// JSON by default; ?format=md returns a downloadable markdown document to attach to the case.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { loadPlaybook, renderPlaybookMarkdown } from "@/lib/cases/playbook";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const pb = await loadPlaybook(db, params.id);
  if (!pb) return NextResponse.json({ error: "not found" }, { status: 404 });

  const format = new URL(req.url).searchParams.get("format");
  if (format === "md") {
    return new NextResponse(renderPlaybookMarkdown(pb), {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="playbook-${pb.caseNumber ?? pb.caseId}.md"`,
      },
    });
  }
  return NextResponse.json(pb);
}
