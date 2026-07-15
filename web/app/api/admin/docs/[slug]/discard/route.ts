// POST — discard a document's pending draft. Body: { versionId }. Requires a manage-docs role.
import { NextResponse } from "next/server";
import { recordAudit } from "@/lib/auth/audit";
import { guardManageDocs } from "@/lib/docs/route-gate";
import { getDocumentDetail, discardDraft } from "@/lib/docs/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const g = await guardManageDocs();
  if (g.res) return g.res;

  const body = (await req.json().catch(() => ({}))) as { versionId?: string };
  const versionId = typeof body.versionId === "string" ? body.versionId : "";
  if (!versionId) return NextResponse.json({ error: "versionId is required" }, { status: 400 });

  const detail = await getDocumentDetail(params.slug);
  if (!detail) return NextResponse.json({ error: "document not found" }, { status: 404 });
  if (!detail.draft || detail.draft.id !== versionId) return NextResponse.json({ error: "that draft is no longer pending" }, { status: 409 });

  const result = await discardDraft(versionId);
  if (!result.ok) return NextResponse.json({ error: result.error ?? "discard failed" }, { status: 409 });

  await recordAudit("document.discard", { user: g.user, detail: { slug: params.slug, version: detail.draft.version } });
  return NextResponse.json({ ok: true });
}
