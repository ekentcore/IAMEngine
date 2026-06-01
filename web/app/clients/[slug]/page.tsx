// Client detail (server component): roster metadata + the modeled systems and their flags.
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { makeClientRepository } from "@/lib/clients/repository";
import { kbUrl } from "@/lib/servicenow/kb-url";
import { automationPreview } from "@/lib/automation";
import { EditSystemsButton } from "../_components/edit-systems-button";
import { RunbookView, type RunbookItemVM } from "../_components/runbook-view";

export const dynamic = "force-dynamic";

export default async function ClientDetailPage({ params }: { params: { slug: string } }) {
  const client = await makeClientRepository(db).getClientBySlug(params.slug);
  if (!client) notFound();

  const runbook = await db.runbookSection.findMany({
    where: { clientId: client.id },
    orderBy: [{ action: "asc" }, { seq: "asc" }],
  });

  // index systems for dependency badges + per-system config (code preview)
  const sysByKey = new Map(client.systems.map((s) => [s.systemKey, s]));
  const keysInAction: Record<"onboard" | "offboard", Set<string>> = { onboard: new Set(), offboard: new Set() };
  for (const r of runbook) if (r.systemKey) keysInAction[r.action].add(r.systemKey);

  const items: RunbookItemVM[] = runbook.map((r) => {
    const sys = r.systemKey ? sysByKey.get(r.systemKey) : undefined;
    const cfg = (sys?.config ?? null) as { onboard?: unknown; offboard?: unknown; dependsOn?: Record<string, string[]> } | null;
    // lane-specific deps win over the system-level list (mirrors orchestrator.depsOf), filtered
    // to systems actually present in this action's runbook.
    const laneDeps = cfg?.dependsOn?.[r.action];
    const after = sys ? (laneDeps ?? sys.dependsOn ?? []).filter((d) => keysInAction[r.action].has(d)) : [];
    const laneConfig = cfg?.[r.action] ?? null;
    const code = r.status === "automated" && r.systemKey
      ? automationPreview(r.systemKey, r.action, laneConfig, client.identity, client.primaryDomain)
      : null;
    return {
      id: `${r.action}-${r.seq}`,
      action: r.action,
      status: r.status,
      systemKey: r.systemKey,
      title: r.title,
      guess: r.guess,
      steps: r.steps,
      after,
      kbHref: kbUrl(r.kbArticle),
      kbNum: r.kbArticle,
      code,
    };
  });

  const onboardKb = items.find((i) => i.action === "onboard" && i.kbHref)?.kbHref ?? null;
  const offboardKb = items.find((i) => i.action === "offboard" && i.kbHref)?.kbHref ?? null;

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
      {(onboardKb || offboardKb) && (
        <p className="note">
          Source KB:{" "}
          {onboardKb && <a href={onboardKb} target="_blank" rel="noreferrer">onboard →</a>}
          {onboardKb && offboardKb && " · "}
          {offboardKb && <a href={offboardKb} target="_blank" rel="noreferrer">offboard →</a>}
        </p>
      )}
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
      {items.length === 0 ? (
        <p className="note">No generated runbook yet — run <code>tools/profile-generator/run.sh</code> then <code>npm run db:seed</code>.</p>
      ) : (
        <RunbookView items={items} />
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
