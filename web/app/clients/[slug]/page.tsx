// Client detail (server component): roster metadata + the modeled systems and their flags.
import Link from "next/link";
import { notFound } from "next/navigation";
import type { RunbookSection } from "@prisma/client";
import { db } from "@/lib/db";
import { makeClientRepository } from "@/lib/clients/repository";
import { EditSystemsButton } from "../_components/edit-systems-button";

export const dynamic = "force-dynamic";

export default async function ClientDetailPage({ params }: { params: { slug: string } }) {
  const client = await makeClientRepository(db).getClientBySlug(params.slug);
  if (!client) notFound();

  const runbook = await db.runbookSection.findMany({
    where: { clientId: client.id },
    orderBy: [{ action: "asc" }, { seq: "asc" }],
  });

  return (
    <main>
      <p className="note">
        <Link href="/clients">← Clients</Link>
      </p>
      <div className="row-between">
        <div>
          <h1>{client.name}</h1>
          <p className="note">
            {client.primaryDomain || "no domain"} ·{" "}
            {client.backbone ? `backbone: ${client.backbone}` : "not modeled"} ·{" "}
            {client.status}
          </p>
        </div>
        <EditSystemsButton slug={client.slug} />
      </div>

      <table>
        <tbody>
          <Field label="CORE id" value={client.coreId} />
          <Field label="Region" value={client.region} />
          <Field label="Timezone" value={client.timezone} />
          <Field label="Support status" value={client.supportStatus} />
          <Field label="Co-managed IT" value={client.coManaged ? "yes" : "no"} />
          <Field
            label="Onboarding / offboarding rating"
            value={`${client.onboardingRating ?? "—"} / ${client.offboardingRating ?? "—"}`}
          />
          <Field
            label="Last synced"
            value={client.snLastSyncedAt ? new Date(client.snLastSyncedAt).toLocaleString() : null}
          />
        </tbody>
      </table>

      <h2>Systems</h2>
      {client.systems.length === 0 ? (
        <p className="note">No profile applied yet — this client is roster-only.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>System</th>
              <th>Mode</th>
              <th>Onboard</th>
              <th>Offboard</th>
              <th>Flags</th>
              <th>Secrets</th>
            </tr>
          </thead>
          <tbody>
            {client.systems.map((s) => (
              <tr key={s.id}>
                <td>
                  {s.system.name}
                  <span className="note"> ({s.systemKey})</span>
                </td>
                <td>
                  <span className="badge">{s.mode}</span>
                </td>
                <td className="muted">{s.onboardWhen}</td>
                <td className="muted">{s.offboardWhen}</td>
                <td className="muted">
                  {[
                    s.requiresApproval ? "approval" : null,
                    s.captureEvidence ? "evidence" : null,
                  ]
                    .filter(Boolean)
                    .join(", ") || "—"}
                </td>
                <td className="muted">{s.secretNames.join(", ") || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 style={{ marginTop: "1.5rem" }}>Runbook — everything to do</h2>
      <p className="note">
        Generated from the ServiceNow KB. ✅ automated steps run via a module; ✋ human-interaction
        steps (manual, or not yet modeled) need a person — those are the module backlog. Expand to see the steps.
      </p>
      <Runbook sections={runbook} />
    </main>
  );
}

function Runbook({ sections }: { sections: RunbookSection[] }) {
  if (sections.length === 0) {
    return <p className="note">No generated runbook yet — run the profile generator (<code>tools/profile-generator/run.sh</code>) and <code>npm run db:seed</code>.</p>;
  }
  return (
    <>
      {(["onboard", "offboard"] as const).map((action) => {
        const items = sections.filter((s) => s.action === action);
        if (items.length === 0) return null;
        const auto = items.filter((s) => s.status === "automated").length;
        return (
          <div key={action} style={{ marginTop: "0.75rem" }}>
            <h3 style={{ textTransform: "capitalize", marginBottom: "0.25rem" }}>{action}</h3>
            <p className="note" style={{ marginTop: 0 }}>{items.length} steps — {auto} automated, {items.length - auto} human interaction</p>
            {items.map((s) => <RunbookItem key={s.id} s={s} />)}
          </div>
        );
      })}
    </>
  );
}

function RunbookItem({ s }: { s: RunbookSection }) {
  const auto = s.status === "automated";
  const label = auto ? "✅ Automated" : s.status === "manual" ? "✋ Human · manual" : "✋ Human · needs module";
  const title = s.systemKey ? `${s.systemKey} — ${s.title}` : s.guess ? `${s.title} (${s.guess})` : s.title;
  return (
    <details style={{ margin: "0.2rem 0", padding: "0.15rem 0" }}>
      <summary>
        <span className="badge" style={{ color: auto ? "#2e7d32" : "#9a6a00" }}>{label}</span> {title}
      </summary>
      {s.steps.length === 0 ? (
        <p className="note" style={{ marginLeft: "1rem" }}>(no step text captured — see the KB article)</p>
      ) : (
        <div style={{ margin: "0.4rem 0 0.6rem" }}>
          {s.steps.map((step, i) => {
            const indent = step.match(/^ */)?.[0].length ?? 0;
            return <div key={i} className="muted" style={{ marginLeft: `${0.8 + indent * 0.6}rem` }}>• {step.trim()}</div>;
          })}
        </div>
      )}
    </details>
  );
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <tr>
      <th style={{ width: "240px" }}>{label}</th>
      <td>{value ?? <span className="muted">—</span>}</td>
    </tr>
  );
}
