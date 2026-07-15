// GET — redline (line diff) between two versions of a document: ?from=<versionId>&to=<versionId>.
// Either id may be the literal "current" (the live published version); `from` defaults to current
// when omitted, so ?to=<id> compares a version against current. Returns the collapsed diff + stats,
// reusing the same diff the draft-review screen uses. Manager-gated (it can surface draft content).
import { NextRequest, NextResponse } from "next/server";
import { guardManageDocs } from "@/lib/docs/route-gate";
import { getDocumentDetail } from "@/lib/docs/store";
import { diffLines, diffStats, collapseUnchanged } from "@/lib/docs/diff";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { slug: string } }) {
  const g = await guardManageDocs();
  if (g.res) return g.res;

  const detail = await getDocumentDetail(params.slug);
  if (!detail) return NextResponse.json({ error: "document not found" }, { status: 404 });

  const url = new URL(req.url);
  const resolve = (id: string | null) =>
    !id || id === "current" ? detail.current : detail.versions.find((v) => v.id === id) ?? null;

  const from = resolve(url.searchParams.get("from"));
  const to = resolve(url.searchParams.get("to"));
  if (!from || !to) return NextResponse.json({ error: "unknown version to compare" }, { status: 404 });

  const full = diffLines(from.markdown, to.markdown);
  const stats = diffStats(full);
  return NextResponse.json({
    from: { id: from.id, version: from.version, status: from.status },
    to: { id: to.id, version: to.version, status: to.status },
    added: stats.added,
    removed: stats.removed,
    diff: collapseUnchanged(full),
  });
}
