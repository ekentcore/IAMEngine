// /docs/[slug] — a single document: the current published version rendered from Markdown, its
// version history, downloads (md/html/docx), and (for admins) the "Update with AI" + review panel.
import type { Metadata } from "next";
import Link from "next/link";
import { loadDoc } from "../_lib/loader";
import { AUDIENCE_LABEL } from "@/lib/docs/store";
import { DownloadMenu } from "./_components/download-menu";
import { ManagePanel } from "./_components/manage-panel";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: { slug: string } }): Promise<Metadata> {
  const d = await loadDoc(params.slug);
  return { title: d.title };
}

export default async function DocPage({ params }: { params: { slug: string } }) {
  const d = await loadDoc(params.slug);

  return (
    <main style={{ maxWidth: 860, margin: "0 auto", padding: "24px 16px 96px" }}>
      <p style={{ margin: "0 0 12px" }}>
        <Link href="/docs" className="nav-link" style={{ padding: 0 }}>← Documents</Link>
      </p>

      <div className="row-between" style={{ alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: 24, margin: "0 0 6px" }}>{d.title}</h1>
          <p className="note" style={{ margin: 0, display: "flex", gap: 8, alignItems: "center" }}>
            {d.audience === "internal" && <span className="doc-badge doc-badge-internal">Internal · staff only</span>}
            <span>{AUDIENCE_LABEL[d.audience]}</span>
            {d.currentVersion && <span>· Version {d.currentVersion}</span>}
          </p>
        </div>
        {d.currentVersion && <DownloadMenu slug={d.slug} version={d.currentVersion} />}
      </div>

      {d.canManage && (
        <ManagePanel
          slug={d.slug}
          currentVersion={d.currentVersion}
          pendingEntries={d.pendingEntries}
          review={d.review}
        />
      )}

      {d.currentVersion ? (
        <article className="doc-body" style={{ marginTop: 24 }} dangerouslySetInnerHTML={{ __html: d.bodyHtml }} />
      ) : (
        <p className="note" style={{ marginTop: 24 }}>This document has no published version yet.</p>
      )}

      <div className="doc-section-label">Version history</div>
      <table className="doc-version-table">
        <thead>
          <tr><th>Version</th><th>Date</th><th>By</th><th>What changed</th></tr>
        </thead>
        <tbody>
          {d.rows.length === 0 ? (
            <tr><td colSpan={4} className="note">No published versions.</td></tr>
          ) : (
            d.rows.map((r) => (
              <tr key={r.version}>
                <td>{r.version}</td>
                <td style={{ whiteSpace: "nowrap" }}>{r.date}</td>
                <td>{r.author}</td>
                <td>{r.changeNote || "—"}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </main>
  );
}
