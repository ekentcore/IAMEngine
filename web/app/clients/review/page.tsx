// Config review: one screen to eyeball that we pulled each client's EMAIL FORMAT and RUNBOOK in
// right. Per client: the username pattern (+ a rendered John-Doe sample) and a runbook summary
// (onboard/offboard section counts, the systems they map to, unmodeled sections, source KB). Flags
// the obvious gaps (no onboarding runbook, missing domain) so they're easy to spot. Read-only.
import Link from "next/link";
import { db } from "@/lib/db";
import { applyUsernamePattern } from "@/lib/servicenow/intake-mapper";

export const dynamic = "force-dynamic";
export const metadata = { title: "Config review" };

const DEFAULT_PATTERN = "{first}.{last}";

// A John-Doe sample of the email the pattern produces, e.g. "{f}{last}" -> "jdoe@acme.com".
function sampleEmail(pattern: string, domain: string): string {
  const local = (pattern.split("|")[0] || DEFAULT_PATTERN).split("@")[0].trim() || DEFAULT_PATTERN;
  const rendered = applyUsernamePattern(local, { first: "John", last: "Doe", mi: "J", domain: "" });
  return domain ? `${rendered}@${domain}` : rendered;
}

export default async function ConfigReviewPage() {
  const [clients, sections] = await Promise.all([
    db.client.findMany({
      where: { archivedAt: null },
      orderBy: { name: "asc" },
      select: { id: true, slug: true, name: true, primaryDomain: true, emailDomain: true, identity: true, editedFields: true, parentId: true },
    }),
    db.runbookSection.findMany({ select: { clientId: true, action: true, systemKey: true, status: true, kbArticle: true } }),
  ]);

  // Per-client runbook rollup.
  type Roll = { onboard: number; offboard: number; systems: Set<string>; unmodeled: number; kbs: Set<string> };
  const roll = new Map<string, Roll>();
  for (const s of sections) {
    const r = roll.get(s.clientId) ?? { onboard: 0, offboard: 0, systems: new Set(), unmodeled: 0, kbs: new Set() };
    if (s.action === "onboard") r.onboard++; else r.offboard++;
    if (s.systemKey) r.systems.add(s.systemKey); else r.unmodeled++;
    if (s.status === "unmodeled") r.unmodeled++;
    if (s.kbArticle) r.kbs.add(s.kbArticle);
    roll.set(s.clientId, r);
  }

  const rows = clients.map((c) => {
    const patterns = ((c.identity as { usernamePatterns?: string[] } | null)?.usernamePatterns ?? []);
    const pattern = patterns[0] || DEFAULT_PATTERN;
    const domain = c.emailDomain || c.primaryDomain || "";
    const r = roll.get(c.id);
    return {
      slug: c.slug, name: c.name, pattern, domain,
      edited: c.editedFields.includes("usernamePattern"),
      sample: sampleEmail(pattern, domain),
      onboard: r?.onboard ?? 0, offboard: r?.offboard ?? 0,
      systems: [...(r?.systems ?? [])].sort(),
      unmodeled: r?.unmodeled ?? 0,
      kbs: [...(r?.kbs ?? [])].sort(),
      hasParent: Boolean(c.parentId),
    };
  });

  const noOnboard = rows.filter((r) => r.onboard === 0 && !r.hasParent).length;
  const noDomain = rows.filter((r) => !r.domain).length;

  return (
    <main style={{ maxWidth: 1200, padding: "1rem 1.25rem" }}>
      <div className="row-between">
        <h1>Config review</h1>
        <Link href="/clients" className="note">← Clients</Link>
      </div>
      <p className="note" style={{ marginTop: 0 }}>
        Quick check that each client&rsquo;s <b>email format</b> and <b>runbook</b> imported correctly. {rows.length} clients ·{" "}
        {noOnboard > 0 ? <b style={{ color: "#b91c1c" }}>{noOnboard} with no onboarding runbook</b> : "all have an onboarding runbook"}
        {noDomain > 0 ? <> · <b style={{ color: "#b91c1c" }}>{noDomain} missing a domain</b></> : null}. Tip: use ⌘/Ctrl-F to find a client.
      </p>

      <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid var(--line, #e5e7eb)" }}>
            <th style={{ padding: "4px 8px" }}>Client</th>
            <th style={{ padding: "4px 8px" }}>Email format</th>
            <th style={{ padding: "4px 8px" }}>Sample</th>
            <th style={{ padding: "4px 8px" }}>Onboard runbook</th>
            <th style={{ padding: "4px 8px" }}>Offboard</th>
            <th style={{ padding: "4px 8px" }}>KB</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.slug} style={{ borderBottom: "1px solid var(--line-2, #f1f5f9)", verticalAlign: "top" }}>
              <td style={{ padding: "4px 8px" }}>
                <Link href={`/clients/${r.slug}`}>{r.name}</Link>
                {r.hasParent && <span className="note" style={{ marginLeft: 4, fontSize: 10 }}>child</span>}
              </td>
              <td style={{ padding: "4px 8px", fontFamily: "monospace" }}>
                {r.pattern}{r.edited && <span title="hand-edited" style={{ color: "#2563eb" }}> ●</span>}
              </td>
              <td style={{ padding: "4px 8px", fontFamily: "monospace", color: r.domain ? "var(--fg)" : "#b91c1c" }}>
                {r.domain ? r.sample : "⚠ no domain"}
              </td>
              <td style={{ padding: "4px 8px" }}>
                {r.onboard === 0 ? (
                  r.hasParent ? <span className="note">inherits parent</span> : <span style={{ color: "#b91c1c" }}>⚠ none</span>
                ) : (
                  <>
                    <span>{r.onboard} section{r.onboard === 1 ? "" : "s"}</span>
                    {r.systems.length > 0 && <span className="note" style={{ marginLeft: 6 }}>{r.systems.join(", ")}</span>}
                    {r.unmodeled > 0 && <span className="note" style={{ marginLeft: 6, color: "#92400e" }}>· {r.unmodeled} unmodeled</span>}
                  </>
                )}
              </td>
              <td style={{ padding: "4px 8px" }}>{r.offboard > 0 ? `${r.offboard} section${r.offboard === 1 ? "" : "s"}` : <span className="note">—</span>}</td>
              <td style={{ padding: "4px 8px", fontSize: 11 }} className="note">{r.kbs.join(", ") || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
