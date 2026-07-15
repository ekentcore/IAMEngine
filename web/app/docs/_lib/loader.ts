// Shared page-data loaders + gates for /docs. The list is visible to any operator who may view at
// least client-facing docs (engineer and above); the API routes re-guard server-side regardless.
import { notFound, redirect } from "next/navigation";
import type { Role } from "@prisma/client";
import { authEnabled, getCurrentUser } from "@/lib/auth/current-user";
import { canViewDocs, canViewAudience, canManageDocs } from "@/lib/docs/access";
import { listDocumentsForRole, getDocumentDetail, versionRows } from "@/lib/docs/store";
import { markdownToHtml } from "@/lib/docs/render";
import { CHANGELOG } from "@/lib/changelog/entries";
import { changelogSince } from "@/lib/docs/versioning";
import { diffLines, collapseUnchanged, diffStats } from "@/lib/docs/diff";

// The effective role for the request, after the view gate. Redirects out if not allowed.
async function gateRole(): Promise<Role> {
  if (!authEnabled()) return "super_admin";
  const me = await getCurrentUser();
  if (!me || !canViewDocs(me.role)) redirect("/clients");
  return me.role;
}

export async function loadDocsList() {
  const role = await gateRole();
  const authOn = authEnabled();
  const docs = await listDocumentsForRole(role, authOn);
  return { docs, canManage: !authOn || canManageDocs(role) };
}

export async function loadDoc(slug: string) {
  const role = await gateRole();
  const authOn = authEnabled();
  const detail = await getDocumentDetail(slug);
  if (!detail) notFound();
  if (authOn && !canViewAudience(role, detail.doc.audience)) redirect("/docs");

  const canManage = !authOn || canManageDocs(role);
  const current = detail.current;
  const bodyHtml = current ? markdownToHtml(current.markdown) : "";
  const rows = versionRows(detail.versions);

  // The draft-review payload is only assembled for a manager, and only when a draft exists.
  let review = null as null | { version: string; changeNote: string; entriesConsidered: number; generatedByAi: boolean; shrunk: boolean; added: number; removed: number; diff: { type: string; text: string }[]; draftId: string };
  if (canManage && detail.draft) {
    const d = detail.draft;
    const full = diffLines(current?.markdown ?? "", d.markdown);
    const stats = diffStats(full);
    review = {
      draftId: d.id,
      version: d.version,
      changeNote: d.changeNote ?? "",
      entriesConsidered: changelogSince(CHANGELOG, current?.changelogThrough).length,
      generatedByAi: d.generatedByAi,
      shrunk: d.markdown.length < (current?.markdown.length ?? 0) * 0.6,
      added: stats.added,
      removed: stats.removed,
      diff: collapseUnchanged(full),
    };
  }

  // How many change-log entries a fresh update would consider (shown on the Update button).
  const pendingEntries = changelogSince(CHANGELOG, current?.changelogThrough).length;

  return {
    slug,
    title: detail.doc.title,
    audience: detail.doc.audience,
    currentVersion: current?.version ?? null,
    bodyHtml,
    rows,
    canManage,
    hasDraft: !!detail.draft,
    review,
    pendingEntries,
  };
}
