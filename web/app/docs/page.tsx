// /docs — the reference documents (client overview, setup guide, security design, internal
// reference), each versioned in-app, viewable and downloadable, with an admin "Update with AI".
import type { Metadata } from "next";
import Link from "next/link";
import { loadDocsList } from "./_lib/loader";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Documents" };

export default async function DocsPage() {
  const { docs } = await loadDocsList();
  return (
    <main style={{ maxWidth: 860, margin: "0 auto", padding: "24px 16px 80px" }}>
      <h1 style={{ fontSize: 24, margin: "0 0 4px" }}>Documents</h1>
      <p className="note" style={{ marginTop: 0 }}>
        The IAM Engine reference documents. Each is versioned in-app — download the current version, or (as an admin) update one from the change log.
      </p>

      {docs.length === 0 ? (
        <p className="note">No documents yet.</p>
      ) : (
        <div style={{ display: "grid", gap: 10, marginTop: 16 }}>
          {docs.map((d) => (
            <Link
              key={d.slug}
              href={`/docs/${d.slug}`}
              style={{ display: "block", border: "1px solid var(--line, #e5e7eb)", borderRadius: 10, padding: "14px 16px", textDecoration: "none", color: "inherit" }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
                <strong style={{ fontSize: 16 }}>{d.title}</strong>
                <span className="note" style={{ whiteSpace: "nowrap", fontSize: 13 }}>
                  {d.currentVersion ? `v${d.currentVersion}` : "no version"} · {d.updatedAt}
                </span>
              </div>
              {d.summary && <p className="note" style={{ margin: "6px 0 0" }}>{d.summary}</p>}
              <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center" }}>
                {d.audience === "internal" && <span className="doc-badge doc-badge-internal">Internal · staff only</span>}
                {d.hasDraft && <span className="doc-badge doc-badge-draft">Draft awaiting review</span>}
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
