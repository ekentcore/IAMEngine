// Client detail (server component): roster metadata + the modeled systems and their flags.
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { makeClientRepository } from "@/lib/clients/repository";
import { kbUrl } from "@/lib/servicenow/kb-url";
import { automationPreview } from "@/lib/automation";
import { asArtifacts } from "@/lib/runbook/artifacts";
import { EditSystemsButton } from "../_components/edit-systems-button";
import { ReplanCasesButton } from "../_components/replan-cases-button";
import { RunbookView, type RunbookItemVM } from "../_components/runbook-view";
import { RunbookEditor } from "../_components/runbook-editor";
import { M365LicenseEditor } from "../_components/m365-license-editor";
import { M365GroupsEditor } from "../_components/m365-groups-editor";
import { M365PasswordEditor } from "../_components/m365-password-editor";
import { RolesRulesView } from "../_components/roles-rules-view";
import { EditRulesButton } from "../_components/edit-rules-button";
import { SecretsPanel } from "../_components/secrets-panel";
import { ConnectionTestPanel } from "../_components/connection-test-panel";
import { deriveSecretRows } from "@/lib/secrets/wiring";
import { delineaConfigured, delineaConfigFromEnv } from "@/lib/secrets/delinea";

export const dynamic = "force-dynamic";

// Tab title = the client's name, so open client tabs are tellable apart.
export async function generateMetadata({ params }: { params: { slug: string } }) {
  const c = await db.client.findUnique({ where: { slug: params.slug }, select: { name: true } });
  return { title: c?.name ?? params.slug };
}

// Hover help for the systems table — explains the columns + flags that aren't self-evident.
const HELP = {
  module:
    "The shared Coretelligent.* PowerShell module that runs this system. Rows under one module are different lanes of the SAME module — e.g. Entra, Exchange and M365 all run on Coretelligent.M365.",
  mode: "How the step runs — api: automated via the module · browser: Playwright automation · manual: a human checklist item.",
  onboard: "When this system runs on onboarding — always · on_request (only when the intake asks) · never (not part of onboarding).",
  offboard: "When this system runs on offboarding — always · on_request · never.",
  flags: "approval = destructive step, gated server-side until approved. evidence = snapshot the before-state and attach it to the case before any destructive change.",
  secrets: "Delinea secret references the runner brokers at run time — names only, never values.",
  approval: "Destructive step — gated server-side; it won't run until an operator approves it.",
  evidence:
    "Captures the before-state (group memberships, license/app assignments) and attaches it to the case BEFORE anything is removed — for audit and restore. Mainly used on offboarding.",
};
const laneHelp = (l: string) =>
  l === "always" ? "Runs every time for this action" : l === "on_request" ? "Runs only when the intake form requests it" : "Not part of this action";

type SysRow = {
  id: string; systemKey: string; mode: string; onboardWhen: string; offboardWhen: string;
  requiresApproval: boolean; captureEvidence: boolean; secretNames: string[];
  system: { name: string; buildTier: number; moduleName: string | null };
};

// Group systems by the module that runs them so module-mates read together; modules with a
// real name first (by build tier), standalone (no-module) systems last; within a group by key.
function groupByModule(systems: SysRow[]) {
  const groups = new Map<string, SysRow[]>();
  for (const s of systems) {
    const k = s.system.moduleName ?? "";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(s);
  }
  return [...groups.entries()]
    .map(([k, sys]) => ({ module: k || null, systems: [...sys].sort((a, b) => a.systemKey.localeCompare(b.systemKey)), tier: Math.min(...sys.map((x) => x.system.buildTier)) }))
    .sort((a, b) => (!!a.module !== !!b.module ? (a.module ? -1 : 1) : a.tier !== b.tier ? a.tier - b.tier : (a.module ?? "").localeCompare(b.module ?? "")));
}

export default async function ClientDetailPage({ params }: { params: { slug: string } }) {
  const client = await makeClientRepository(db).getClientBySlug(params.slug);
  if (!client) notFound();

  // v2.1 resolution rules (personas/globals/locations) — the conditional group/OU/attribute logic.
  const v21 = await db.client.findUnique({ where: { id: client.id }, select: { personas: true, globals: true, locations: true } });

  // Account hierarchy: a child with no systems of its own plans with its PARENT's runbook (see
  // clientForPlanning). Surface that here so an "empty" child isn't mistaken for unmodeled.
  const parentInfo = client.systems.length === 0
    ? (await db.client.findUnique({ where: { id: client.id }, select: { parent: { select: { slug: true, name: true, _count: { select: { systems: true } } } } } }))?.parent ?? null
    : null;
  const hasRules = Boolean((v21?.personas && Object.keys(v21.personas).length) || (v21?.globals && Object.keys(v21.globals).length));

  const runbook = await db.runbookSection.findMany({
    where: { clientId: client.id },
    orderBy: [{ action: "asc" }, { seq: "asc" }],
  });

  // Secret wiring: every secretName the systems reference + the saved Delinea references (with id).
  const wiring = await makeClientRepository(db).secretsWiring(params.slug);
  const secretRows = wiring ? deriveSecretRows(wiring.systems, wiring.secrets) : [];

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
      seq: r.seq,
      status: r.status,
      systemKey: r.systemKey,
      title: r.title,
      guess: r.guess,
      steps: r.steps,
      after,
      kbHref: kbUrl(r.kbArticle),
      kbNum: r.kbArticle,
      code,
      artifacts: asArtifacts(r.artifacts),
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
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <ReplanCasesButton slug={client.slug} />
          <EditSystemsButton slug={client.slug} />
        </div>
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
      {sysByKey.has("m365") && (
        <M365LicenseEditor
          slug={client.slug}
          current={(() => {
            const cfg = (sysByKey.get("m365")?.config ?? {}) as { onboard?: { licenses?: unknown; defaultLicenses?: unknown } };
            const lic = cfg.onboard?.licenses ?? cfg.onboard?.defaultLicenses ?? [];
            return Array.isArray(lic) ? lic.map((l) => (typeof l === "string" ? l : String((l as { name?: unknown })?.name ?? ""))).filter(Boolean) : [];
          })()}
        />
      )}
      {sysByKey.has("m365") && (
        <M365GroupsEditor
          slug={client.slug}
          current={(() => {
            const cfg = (sysByKey.get("m365")?.config ?? {}) as { onboard?: { groups?: unknown; defaultGroups?: unknown } };
            const gs = cfg.onboard?.groups ?? cfg.onboard?.defaultGroups ?? [];
            return Array.isArray(gs)
              ? gs.map((x) => (typeof x === "string" ? { name: x } : { name: String((x as { name?: unknown })?.name ?? ""), type: (x as { type?: string })?.type })).filter((x) => x.name)
              : [];
          })()}
        />
      )}
      {sysByKey.has("m365") && (
        <M365PasswordEditor
          slug={client.slug}
          current={(() => {
            const ob = ((sysByKey.get("m365")?.config ?? {}) as { onboard?: { initialPassword?: unknown; initialPasswordSecret?: unknown } }).onboard ?? {};
            if (typeof ob.initialPasswordSecret === "string" && ob.initialPasswordSecret) {
              // Surface the wired Delinea id so opening the editor shows the secret number already set.
              const delineaId = secretRows.find((r) => r.name === ob.initialPasswordSecret)?.externalId ?? "";
              return { mode: "secret" as const, delineaId };
            }
            if (typeof ob.initialPassword === "string" && ob.initialPassword) return { mode: "fixed" as const };
            return { mode: "generate" as const };
          })()}
        />
      )}
      {(onboardKb || offboardKb) && (
        <p className="note">
          Source KB:{" "}
          {onboardKb && <a href={onboardKb} target="_blank" rel="noreferrer">onboard →</a>}
          {onboardKb && offboardKb && " · "}
          {offboardKb && <a href={offboardKb} target="_blank" rel="noreferrer">offboard →</a>}
        </p>
      )}
      {client.systems.length === 0 ? (
        parentInfo && parentInfo._count.systems > 0 ? (
          <div style={{ border: "1px solid #bfdbfe", background: "#eff6ff", borderRadius: 6, padding: "0.7rem 0.9rem" }}>
            <b>Inherits the parent&rsquo;s runbook.</b>{" "}
            This client has no modeled systems of its own, so cases plan with the parent account&rsquo;s systems:{" "}
            <Link href={`/clients/${parentInfo.slug}`}>{parentInfo.name}</Link> ({parentInfo._count.systems} systems).
            {" "}Credentials still resolve on <i>this</i> client — wire its secrets (or override per case).
            {" "}Add systems here to diverge from the parent.
          </div>
        ) : (
          <p className="note">No profile applied yet — this client is roster-only.</p>
        )
      ) : (
        <>
        <p className="note" style={{ marginTop: 0 }}>
          Grouped by the module that runs each system — rows under one module (e.g. Entra / Exchange / M365) are different lanes of the same module. Hover a column or flag for what it means.
        </p>
        <table>
          <thead>
            <tr>
              <th className="help" title={HELP.module}>Module</th>
              <th>System</th>
              <th className="help" title={HELP.mode}>Mode</th>
              <th className="help" title={HELP.onboard}>Onboard</th>
              <th className="help" title={HELP.offboard}>Offboard</th>
              <th className="help" title={HELP.flags}>Flags</th>
              <th className="help" title={HELP.secrets}>Secrets</th>
            </tr>
          </thead>
          <tbody>
            {groupByModule(client.systems).map((g) =>
              g.systems.map((s, i) => (
                <tr key={s.id}>
                  {i === 0 && (
                    <td rowSpan={g.systems.length} className="module-cell" title={g.module ? `${g.systems.length} lane${g.systems.length > 1 ? "s" : ""} on ${g.module}` : "Standalone — no shared Coretelligent.* module"}>
                      {g.module ? g.module.replace(/^Coretelligent\./, "") : <span className="muted">—</span>}
                    </td>
                  )}
                  <td>
                    {s.system.name}
                    <span className="note"> ({s.systemKey})</span>
                  </td>
                  <td>
                    <span className="badge" title={`${s.mode} mode`}>{s.mode}</span>
                  </td>
                  <td className="muted help" title={laneHelp(s.onboardWhen)}>{s.onboardWhen}</td>
                  <td className="muted help" title={laneHelp(s.offboardWhen)}>{s.offboardWhen}</td>
                  <td className="muted">
                    {!s.requiresApproval && !s.captureEvidence && "—"}
                    {s.requiresApproval && <span className="badge help" title={HELP.approval}>approval</span>}
                    {s.captureEvidence && <span className="badge help" title={HELP.evidence} style={{ marginLeft: s.requiresApproval ? 4 : 0 }}>evidence</span>}
                  </td>
                  <td className="muted">{s.secretNames.join(", ") || "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        </>
      )}

      <div className="row-between" style={{ marginTop: "1.5rem" }}>
        <h2 style={{ margin: 0 }}>Roles &amp; rules</h2>
        <EditRulesButton slug={client.slug} />
      </div>
      {hasRules ? (
        <RolesRulesView
          personas={v21?.personas as never}
          globals={v21?.globals as never}
          locations={v21?.locations as never}
        />
      ) : (
        <p className="note">No personas or rules yet. Use <b>Edit rules</b> to add an if-then rule (e.g. “if country.short == IN → add Podshore-ALL”).</p>
      )}

      <h2 style={{ marginTop: "1.5rem" }}>Secret wiring (Delinea)</h2>
      <SecretsPanel slug={client.slug} initialRows={secretRows} delineaConfigured={delineaConfigured(delineaConfigFromEnv())} />

      <h2 style={{ marginTop: "1.5rem" }}>Connection tests</h2>
      <ConnectionTestPanel slug={client.slug} systemNames={Object.fromEntries(client.systems.map((s) => [s.systemKey, s.system.name]))} />

      <h2 style={{ marginTop: "1.5rem" }}>Runbook — everything to do</h2>
      <p className="note">
        Generated from the ServiceNow KB. ✅ automated steps run via a module; ✋ human-interaction
        steps (manual, or not yet modeled) need a person — those are the module backlog. Expand to see the steps.
      </p>
      {items.length === 0 ? (
        <p className="note">No KB runbook for this client. If it&rsquo;s internal or KB-less (process from a script/doc), paste or type the runbook below — it&rsquo;s parsed into steps and known systems are auto-wired.</p>
      ) : (
        <RunbookView items={items} slug={client.slug} />
      )}
      <RunbookEditor
        slug={client.slug}
        kbArticles={Object.values(
          runbook.reduce<Record<string, { number: string; action: "onboard" | "offboard" }>>((acc, r) => {
            if (r.kbArticle && !acc[r.kbArticle]) acc[r.kbArticle] = { number: r.kbArticle, action: r.action };
            return acc;
          }, {})
        )}
      />
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
