// POST — upload an edited copy of a document (multipart form-data, field "file"). Accepts a .docx
// (Word round-trip) or .md, converts it to our canonical Markdown, and stores it as a DRAFT for
// review — the same lifecycle as an AI update, but human-authored (generatedByAi: false). Never
// publishes. Requires a manage-docs role.
import { NextResponse } from "next/server";
import { recordAudit } from "@/lib/auth/audit";
import { guardManageDocs } from "@/lib/docs/route-gate";
import { getDocumentDetail, createDraft } from "@/lib/docs/store";
import { importToMarkdown, detectFormat } from "@/lib/docs/import";
import { isSuspiciousShrink } from "@/lib/docs/versioning";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BYTES = 15 * 1024 * 1024; // a reference doc is tens of KB; 15 MB is a generous ceiling

export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const g = await guardManageDocs();
  if (g.res) return g.res;

  const detail = await getDocumentDetail(params.slug);
  if (!detail) return NextResponse.json({ error: "document not found" }, { status: 404 });
  if (detail.draft) return NextResponse.json({ error: "a draft already exists — review or discard it first" }, { status: 409 });

  let file: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get("file");
    if (f instanceof File) file = f;
  } catch {
    return NextResponse.json({ error: "expected a multipart file upload" }, { status: 400 });
  }
  if (!file) return NextResponse.json({ error: "no file provided" }, { status: 400 });
  if (!detectFormat(file.name)) return NextResponse.json({ error: "unsupported file type — upload a .docx or .md file" }, { status: 415 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "file is too large (15 MB max)" }, { status: 413 });

  let markdown: string;
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    ({ markdown } = await importToMarkdown(file.name, buffer));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "could not read the uploaded file" }, { status: 422 });
  }

  const created = await createDraft({
    documentId: detail.doc.id,
    markdown,
    changeNote: `Uploaded ${file.name}`,
    // An upload isn't derived from the change log; carry the current version's cutoff forward so a
    // later AI update still considers the right window.
    changelogThrough: detail.current?.changelogThrough ?? null,
    createdById: g.user.system ? null : g.user.id,
    createdByLabel: g.user.system ? "System" : g.user.email,
    generatedByAi: false,
  });
  if (created.error || !created.draft) return NextResponse.json({ error: created.error ?? "could not create draft" }, { status: 409 });

  const shrunk = isSuspiciousShrink(detail.current?.markdown, markdown);
  await recordAudit("document.upload", { user: g.user, detail: { slug: params.slug, version: created.draft.version, filename: file.name, shrunk } });

  return NextResponse.json({ draft: { id: created.draft.id, version: created.draft.version }, filename: file.name, shrunk });
}
