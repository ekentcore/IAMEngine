// Download a document as Markdown, a self-contained HTML page, or a Word .docx. Any signed-in
// operator may read a document their role is allowed to see (audience is re-checked here, not just
// hidden in the UI). Serves the current published version by default; ?version=<id> serves a
// specific version (a draft only for a manager, for the review screen's "preview").
import { NextRequest, NextResponse } from "next/server";
import { guardAuth } from "@/lib/auth/route-guard";
import { authEnabled } from "@/lib/auth/current-user";
import { canViewAudience, canManageDocs } from "@/lib/docs/access";
import { getDocumentDetail, versionRows, AUDIENCE_LABEL } from "@/lib/docs/store";
import { markdownToHtml, styledHtmlDocument } from "@/lib/docs/render";
import { markdownToDocxBuffer } from "@/lib/docs/docx";

export const dynamic = "force-dynamic";

type Format = "md" | "html" | "docx";

export async function GET(req: NextRequest, { params }: { params: { slug: string } }) {
  const g = await guardAuth();
  if (g.res) return g.res;

  const authOn = authEnabled();
  const detail = await getDocumentDetail(params.slug);
  if (!detail) return NextResponse.json({ error: "document not found" }, { status: 404 });
  if (authOn && !canViewAudience(g.user.role, detail.doc.audience)) return NextResponse.json({ error: "not allowed to view this document" }, { status: 403 });

  const url = new URL(req.url);
  const format = (url.searchParams.get("format") ?? "md") as Format;
  const versionId = url.searchParams.get("version");

  // Resolve the version to serve.
  const version = versionId
    ? detail.versions.find((v) => v.id === versionId && (v.status === "published" || !authOn || canManageDocs(g.user.role)))
    : detail.current;
  if (!version) return NextResponse.json({ error: "no published version to download" }, { status: 404 });

  const filenameBase = `${detail.doc.slug}-v${version.version}`;
  const rows = versionRows(detail.versions);
  const audienceLabel = AUDIENCE_LABEL[detail.doc.audience];

  if (format === "md") {
    return new NextResponse(version.markdown, {
      headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="${filenameBase}.md"` },
    });
  }

  if (format === "html") {
    const html = styledHtmlDocument({ title: detail.doc.title, audienceLabel, version: version.version, bodyHtml: markdownToHtml(version.markdown), versionRows: rows });
    return new NextResponse(html, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Content-Disposition": `attachment; filename="${filenameBase}.html"` },
    });
  }

  if (format === "docx") {
    const buffer = await markdownToDocxBuffer({ title: detail.doc.title, audienceLabel, version: version.version, markdown: version.markdown, versionRows: rows });
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${filenameBase}.docx"`,
      },
    });
  }

  return NextResponse.json({ error: "unknown format — use md, html, or docx" }, { status: 400 });
}
