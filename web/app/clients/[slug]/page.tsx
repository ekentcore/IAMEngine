// Client detail (server component): roster metadata + the modeled systems and their flags.
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { makeClientRepository } from "@/lib/clients/repository";
import { EditSystemsButton } from "../_components/edit-systems-button";

export const dynamic = "force-dynamic";

export default async function ClientDetailPage({ params }: { params: { slug: string } }) {
  const client = await makeClientRepository(db).getClientBySlug(params.slug);
  if (!client) notFound();

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
    </main>
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
