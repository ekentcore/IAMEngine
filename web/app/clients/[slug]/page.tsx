// Client detail: systems table + onboarding/offboarding runbooks. Server component —
// loads the client, builds each runbook from the data, and pre-computes the M365
// code previews (the templater runs server-side); RunbookView holds UI state.
import { notFound } from "next/navigation";
import Link from "next/link";
import { getClientBySlug } from "@/lib/clients/repository";
import { buildRunbook } from "@/lib/runbook/build";
import { previewFor } from "@/lib/automation";
import { kbUrl } from "@/lib/servicenow/kb-url";
import { RunbookView } from "../_components/runbook-view";
import type { Identity, KbRef, RunbookItem } from "@/lib/clients/types";
import type { Action } from "@prisma/client";

export const dynamic = "force-dynamic";

type KbBlock = Partial<Record<Action, { number?: string }>> | null;

export default async function ClientPage({ params }: { params: { slug: string } }) {
  const client = await getClientBySlug(params.slug);
  if (!client) notFound();

  const identity = client.identity as Identity | null;
  const kb = client.kb as KbBlock;
  const snUrl = process.env.SN_INSTANCE_URL;

  const kbRef = (action: Action): KbRef | null => {
    const number = kb?.[action]?.number;
    return number ? { number, url: kbUrl(snUrl, number) } : null;
  };

  // Build each runbook and attach code previews for automated, previewable systems.
  const runbook = (action: Action): RunbookItem[] => {
    const items = buildRunbook(client.systems, action);
    for (const item of items) {
      if (!item.automated) continue;
      const sys = client.systems.find((s) => s.systemKey === item.systemKey);
      const config = (sys?.config as Record<string, unknown> | null)?.[action] as
        | Record<string, unknown>
        | null;
      item.codePreview = previewFor(item.systemKey, action, config ?? null, identity, client.primaryDomain);
    }
    return items;
  };

  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif", maxWidth: 900 }}>
      <p style={{ margin: 0 }}>
        <Link href="/clients">← Clients</Link>
      </p>
      <h1 style={{ marginBottom: 0 }}>{client.name}</h1>
      <p style={{ color: "#666", marginTop: ".25rem" }}>
        {client.primaryDomain} · {client.backbone} · {client.status}
      </p>

      <h2 style={{ marginTop: "1.5rem" }}>Systems</h2>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
            <th style={th}>System</th>
            <th style={th}>Mode</th>
            <th style={th}>Onboard</th>
            <th style={th}>Offboard</th>
            <th style={th}>Depends on</th>
            <th style={th}>Approval</th>
          </tr>
        </thead>
        <tbody>
          {client.systems.map((s) => (
            <tr key={s.id} style={{ borderBottom: "1px solid #eee" }}>
              <td style={td}>{s.system.name}</td>
              <td style={td}>{s.mode}</td>
              <td style={td}>{s.onboardWhen}</td>
              <td style={td}>{s.offboardWhen}</td>
              <td style={td}>{s.dependsOn.join(", ") || "—"}</td>
              <td style={td}>{s.requiresApproval ? "required" : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <RunbookView action="onboard" items={runbook("onboard")} kb={kbRef("onboard")} />
      <RunbookView action="offboard" items={runbook("offboard")} kb={kbRef("offboard")} />
    </main>
  );
}

const th: React.CSSProperties = { padding: ".4rem .5rem", fontWeight: 600 };
const td: React.CSSProperties = { padding: ".4rem .5rem", verticalAlign: "top" };
