// Data access for documents + their version chain, and the draft → publish → discard lifecycle.
import type { Document, DocumentVersion, Role } from "@prisma/client";
import { db } from "@/lib/db";
import { canViewAudience } from "./access";
import { compareVersions, nextVersion, type VersionBump } from "./versioning";
import type { VersionRow } from "./render";

export const AUDIENCE_LABEL = { client: "Client-facing", internal: "Internal — staff only" } as const;

// The live version of a document = the newest PUBLISHED one (by version number, then publish time).
export function latestPublished(versions: DocumentVersion[]): DocumentVersion | null {
  const published = versions.filter((v) => v.status === "published");
  if (!published.length) return null;
  return published.sort((a, b) => {
    const byVersion = compareVersions(b.version, a.version);
    if (byVersion !== 0) return byVersion;
    return (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0);
  })[0];
}

// At most one draft is allowed to exist at a time (the newest, if any).
export function pendingDraft(versions: DocumentVersion[]): DocumentVersion | null {
  const drafts = versions.filter((v) => v.status === "draft").sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return drafts[0] ?? null;
}

function ymd(d: Date | null | undefined): string {
  return d ? d.toISOString().slice(0, 10) : "—";
}

// The published versions as display rows (newest first) for the on-document version table.
export function versionRows(versions: DocumentVersion[]): VersionRow[] {
  return versions
    .filter((v) => v.status === "published")
    .sort((a, b) => compareVersions(b.version, a.version))
    .map((v) => ({ version: v.version, date: ymd(v.publishedAt ?? v.createdAt), changeNote: v.changeNote ?? "", author: v.createdByLabel ?? "—" }));
}

export type DocListItem = {
  slug: string;
  title: string;
  audience: Document["audience"];
  summary: string | null;
  currentVersion: string | null;
  updatedAt: string; // YYYY-MM-DD of the current version's publish (or doc update)
  hasDraft: boolean;
};

// Documents the role may see, each with its current-version summary. Internal docs are filtered out
// for roles below global_admin — the hard filter, not just a hidden link.
export async function listDocumentsForRole(role: Role, authOn: boolean): Promise<DocListItem[]> {
  const docs = await db.document.findMany({ orderBy: [{ sortOrder: "asc" }, { title: "asc" }], include: { versions: true } });
  return docs
    .filter((d) => !authOn || canViewAudience(role, d.audience))
    .map((d) => {
      const cur = latestPublished(d.versions);
      return {
        slug: d.slug,
        title: d.title,
        audience: d.audience,
        summary: d.summary,
        currentVersion: cur?.version ?? null,
        updatedAt: ymd(cur?.publishedAt ?? d.updatedAt),
        hasDraft: pendingDraft(d.versions) !== null,
      };
    });
}

export type DocDetail = { doc: Document; versions: DocumentVersion[]; current: DocumentVersion | null; draft: DocumentVersion | null };

export async function getDocumentDetail(slug: string): Promise<DocDetail | null> {
  const doc = await db.document.findUnique({ where: { slug }, include: { versions: true } });
  if (!doc) return null;
  return { doc, versions: doc.versions, current: latestPublished(doc.versions), draft: pendingDraft(doc.versions) };
}

// Create an AI draft. Rejects if a draft already exists (one at a time). The provisional version
// label is a minor bump off the current published version; it's re-derived at publish time in case
// the current version moved in between.
export async function createDraft(opts: {
  documentId: string;
  markdown: string;
  changeNote: string;
  changelogThrough: string | null;
  createdById: string | null;
  createdByLabel: string;
  generatedByAi?: boolean; // AI update = true (default); an uploaded copy = false
}): Promise<{ draft?: DocumentVersion; error?: string }> {
  const doc = await db.document.findUnique({ where: { id: opts.documentId }, include: { versions: true } });
  if (!doc) return { error: "document not found" };
  if (pendingDraft(doc.versions)) return { error: "a draft already exists — publish or discard it first" };
  const current = latestPublished(doc.versions);
  const version = nextVersion(current?.version ?? "1.0", "minor");
  const draft = await db.documentVersion.create({
    data: {
      documentId: opts.documentId,
      version,
      status: "draft",
      markdown: opts.markdown,
      changeNote: opts.changeNote,
      generatedByAi: opts.generatedByAi ?? true,
      changelogThrough: opts.changelogThrough,
      createdById: opts.createdById,
      createdByLabel: opts.createdByLabel,
    },
  });
  return { draft };
}

// Publish a draft: re-derive its version off the current published version (respecting a major bump
// if requested), stamp publishedAt, and mark it published. Idempotent-ish: publishing a non-draft
// returns an error rather than double-publishing.
export async function publishDraft(versionId: string, bump: VersionBump, label: string, userId: string | null): Promise<{ version?: DocumentVersion; error?: string }> {
  return db.$transaction(async (tx) => {
    const draft = await tx.documentVersion.findUnique({ where: { id: versionId } });
    if (!draft || draft.status !== "draft") return { error: "no such draft" };
    const siblings = await tx.documentVersion.findMany({ where: { documentId: draft.documentId } });
    const current = latestPublished(siblings);
    const version = nextVersion(current?.version ?? "1.0", bump);
    const updated = await tx.documentVersion.update({
      where: { id: versionId },
      data: { status: "published", version, publishedAt: new Date(), createdByLabel: draft.createdByLabel ?? label, createdById: draft.createdById ?? userId },
    });
    await tx.document.update({ where: { id: draft.documentId }, data: { updatedAt: new Date() } });
    return { version: updated };
  });
}

export async function discardDraft(versionId: string): Promise<{ ok: boolean; error?: string }> {
  const draft = await db.documentVersion.findUnique({ where: { id: versionId } });
  if (!draft || draft.status !== "draft") return { ok: false, error: "no such draft" };
  await db.documentVersion.delete({ where: { id: versionId } });
  return { ok: true };
}
