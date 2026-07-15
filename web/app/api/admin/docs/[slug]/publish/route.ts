// POST — publish a document's pending draft as the new current version. Body: { versionId, bump }
// where bump is "minor" (default, 1.0 → 1.1) or "major" (1.4 → 2.0). Requires a manage-docs role.
import { NextResponse } from "next/server";
import { recordAudit } from "@/lib/auth/audit";
import { guardManageDocs } from "@/lib/docs/route-gate";
import { getDocumentDetail, publishDraft } from "@/lib/docs/store";
import type { VersionBump } from "@/lib/docs/versioning";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const g = await guardManageDocs();
  if (g.res) return g.res;

  const body = (await req.json().catch(() => ({}))) as { versionId?: string; bump?: string };
  const versionId = typeof body.versionId === "string" ? body.versionId : "";
  const bump: VersionBump = body.bump === "major" ? "major" : "minor";
  if (!versionId) return NextResponse.json({ error: "versionId is required" }, { status: 400 });

  const detail = await getDocumentDetail(params.slug);
  if (!detail) return NextResponse.json({ error: "document not found" }, { status: 404 });
  if (!detail.draft || detail.draft.id !== versionId) return NextResponse.json({ error: "that draft is no longer pending" }, { status: 409 });

  const result = await publishDraft(versionId, bump, g.user.system ? "System" : g.user.email, g.user.system ? null : g.user.id);
  if (result.error || !result.version) return NextResponse.json({ error: result.error ?? "publish failed" }, { status: 409 });

  await recordAudit("document.publish", { user: g.user, detail: { slug: params.slug, version: result.version.version, bump } });
  return NextResponse.json({ version: result.version.version });
}
