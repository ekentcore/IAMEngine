// Cases list (server component).
import Link from "next/link";
import { db } from "@/lib/db";
import { makeCaseRepository } from "@/lib/cases/repository";
import { CasesToolbar } from "./_components/cases-toolbar";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  queued: "queued",
  planning: "planning",
  running: "running",
  needs_manual: "needs manual",
  needs_approval: "needs approval",
  completed: "completed",
  failed: "failed",
};

export default async function CasesPage() {
  // Clients for the "new case" picker (slug + name only).
  const [cases, clients] = await Promise.all([
    makeCaseRepository(db).listCases(),
    db.client.findMany({
      where: { status: "active" },
      orderBy: { name: "asc" },
      select: { slug: true, name: true },
    }),
  ]);

  return (
    <main>
      <div className="row-between">
        <div>
          <h1>Cases</h1>
          <p className="note">{cases.length} cases · onboarding / offboarding requests</p>
        </div>
      </div>

      <CasesToolbar clients={clients} />

      <table>
        <thead>
          <tr>
            <th>Subject</th>
            <th>Client</th>
            <th>Action</th>
            <th>SN case</th>
            <th>Jobs</th>
            <th>Status</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {cases.map((c) => (
            <tr key={c.id}>
              <td><Link href={`/cases/${c.id}`}>{c.subject ?? c.id.slice(0, 8)}</Link></td>
              <td className="muted">{c.clientName}</td>
              <td><span className="badge">{c.action}</span></td>
              <td className="muted">{c.serviceNowCaseNumber ?? "—"}</td>
              <td className="muted">{c.jobCount}</td>
              <td><span className="badge">{STATUS_LABEL[c.status] ?? c.status}</span></td>
              <td className="muted">{c.createdAt.toLocaleDateString()}</td>
            </tr>
          ))}
          {cases.length === 0 && (
            <tr>
              <td colSpan={7} className="muted" style={{ textAlign: "center", padding: "2rem" }}>
                No cases yet. Import a ServiceNow ticket or create one.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </main>
  );
}
