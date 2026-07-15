// POST — run "Update with AI" for a document: read the change log since the document's current
// version, ask the configured LLM to revise it, and store the result as a DRAFT for review. Never
// publishes. Requires a manage-docs role and a configured LLM provider.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/auth/audit";
import { getDefaultProvider } from "@/lib/fixes/providers";
import { CHANGELOG } from "@/lib/changelog/entries";
import { guardManageDocs } from "@/lib/docs/route-gate";
import { getDocumentDetail, createDraft } from "@/lib/docs/store";
import { changelogSince, newestDate } from "@/lib/docs/versioning";
import { runDocumentUpdate } from "@/lib/docs/ai-update";

export const dynamic = "force-dynamic";
export const maxDuration = 120; // a single large LLM call

export async function POST(_req: Request, { params }: { params: { slug: string } }) {
  const g = await guardManageDocs();
  if (g.res) return g.res;

  const detail = await getDocumentDetail(params.slug);
  if (!detail) return NextResponse.json({ error: "document not found" }, { status: 404 });
  if (!detail.current) return NextResponse.json({ error: "document has no published version to update" }, { status: 409 });
  if (detail.draft) return NextResponse.json({ error: "a draft already exists — review or discard it first" }, { status: 409 });

  const provider = await getDefaultProvider(db);
  if (!provider) return NextResponse.json({ error: "no LLM provider configured — add one in Settings" }, { status: 422 });

  // Only entries newer than what's already folded into the current version.
  const entries = changelogSince(CHANGELOG, detail.current.changelogThrough);
  const through = newestDate(CHANGELOG) ?? detail.current.changelogThrough ?? null;

  let update;
  try {
    update = await runDocumentUpdate(provider, { title: detail.doc.title, currentMarkdown: detail.current.markdown, entries });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "the update call failed" }, { status: 502 });
  }

  const created = await createDraft({
    documentId: detail.doc.id,
    markdown: update.markdown,
    changeNote: update.changeNote || "AI update.",
    changelogThrough: through,
    createdById: g.user.system ? null : g.user.id,
    createdByLabel: g.user.system ? "System" : g.user.email,
  });
  if (created.error || !created.draft) return NextResponse.json({ error: created.error ?? "could not create draft" }, { status: 409 });

  await recordAudit("document.draft", { user: g.user, detail: { slug: params.slug, version: created.draft.version, entriesConsidered: entries.length, shrunk: update.shrunk, provider: provider.name } });

  return NextResponse.json({
    draft: { id: created.draft.id, version: created.draft.version, changeNote: created.draft.changeNote },
    entriesConsidered: entries.length,
    shrunk: update.shrunk,
  });
}
