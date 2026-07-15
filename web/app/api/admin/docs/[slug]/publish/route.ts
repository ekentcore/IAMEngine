// POST — publish a document's pending draft as the new current version. Body: { versionId, bump }
// where bump is "minor" (default, 1.0 → 1.1) or "major" (1.4 → 2.0). Requires a manage-docs role.
import { NextResponse } from "next/server";
import { recordAudit } from "@/lib/auth/audit";
import { guardManageDocs } from "@/lib/docs/route-gate";
import { getDocumentDetail, publishDraft } from "@/lib/docs/store";
import { isSuspiciousShrink, retainedRatio, SHRINK_THRESHOLD, type VersionBump } from "@/lib/docs/versioning";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const g = await guardManageDocs();
  if (g.res) return g.res;

  const body = (await req.json().catch(() => ({}))) as { versionId?: string; bump?: string; allowShrink?: boolean };
  const versionId = typeof body.versionId === "string" ? body.versionId : "";
  const bump: VersionBump = body.bump === "major" ? "major" : "minor";
  const allowShrink = body.allowShrink === true;
  if (!versionId) return NextResponse.json({ error: "versionId is required" }, { status: 400 });

  const detail = await getDocumentDetail(params.slug);
  if (!detail) return NextResponse.json({ error: "document not found" }, { status: 404 });
  if (!detail.draft || detail.draft.id !== versionId) return NextResponse.json({ error: "that draft is no longer pending" }, { status: 409 });

  // Hard shrink guard: a draft much shorter than the current version has almost certainly lost
  // content (truncated model reply, bad Word round-trip). Block publishing unless the reviewer
  // explicitly overrode after checking the redline. The UI warning is advisory; this is the gate.
  if (detail.current && isSuspiciousShrink(detail.current.markdown, detail.draft.markdown) && !allowShrink) {
    const pct = Math.round(retainedRatio(detail.current.markdown, detail.draft.markdown) * 100);
    return NextResponse.json(
      {
        error: `This draft is only ${pct}% the length of the current version (below the ${Math.round(SHRINK_THRESHOLD * 100)}% safety threshold) — it may have dropped content. Review the redline, then confirm to publish anyway.`,
        code: "shrink_blocked",
        retainedPct: pct,
      },
      { status: 409 }
    );
  }

  // Was this a shrinking publish that only went through because the reviewer overrode the guard?
  // Record it so a later "content went missing" investigation can see the bypass was deliberate.
  const shrank = detail.current ? isSuspiciousShrink(detail.current.markdown, detail.draft.markdown) : false;

  const result = await publishDraft(versionId, bump, g.user.system ? "System" : g.user.email, g.user.system ? null : g.user.id);
  if (result.error || !result.version) return NextResponse.json({ error: result.error ?? "publish failed" }, { status: 409 });

  await recordAudit("document.publish", {
    user: g.user,
    detail: {
      slug: params.slug,
      version: result.version.version,
      bump,
      ...(shrank ? { shrinkOverride: true, retainedPct: detail.current ? Math.round(retainedRatio(detail.current.markdown, detail.draft.markdown) * 100) : null } : {}),
    },
  });
  return NextResponse.json({ version: result.version.version });
}
