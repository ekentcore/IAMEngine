// Guided credential-setup wizard (server component). Loads the client's secret wiring + run-readiness,
// computes the ordered step list (buildSetupSteps), and hands it to the client wizard. Same guards as
// the Secrets panel: scope-gated (out-of-scope client 404s) and client.edit_secrets to enter. Adds no
// mutation endpoint — the wizard drives the existing /secrets, /secrets/test and /conn-test routes.
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { makeClientRepository } from "@/lib/clients/repository";
import { currentClientScope } from "@/lib/auth/client-scope";
import { authEnabled, getCurrentUser } from "@/lib/auth/current-user";
import { can } from "@/lib/auth/permissions";
import { deriveSecretRows } from "@/lib/secrets/wiring";
import { delineaConfigured, delineaConfigFromEnv } from "@/lib/secrets/delinea";
import { buildSetupSteps } from "@/lib/clients/setup-steps";
import type { ConnTestState } from "@/lib/clients/readiness";
import { SetupWizard } from "./_components/setup-wizard";

export const dynamic = "force-dynamic";
export const metadata = { title: "Guided setup" };

export default async function ClientSetupPage({ params }: { params: { slug: string } }) {
  // Wiring the same credentials the Secrets panel does — gate on the same capability.
  if (authEnabled()) {
    const me = await getCurrentUser();
    if (!me || !can(me.role, "client.edit_secrets")) redirect(`/clients/${params.slug}`);
  }

  // scope-gated: an out-of-scope (restricted) client reads as not-found.
  const scope = await currentClientScope(db);
  const repo = makeClientRepository(db);
  const client = await repo.getClientBySlug(params.slug, scope);
  if (!client) notFound();

  const wiring = await repo.secretsWiring(params.slug);
  const secretRows = wiring ? deriveSecretRows(wiring.systems, wiring.secrets) : [];
  const readiness = await repo.clientReadiness(params.slug);
  const steps = buildSetupSteps(secretRows, readiness);

  const systemKeys = readiness?.systems.map((s) => s.systemKey) ?? [];
  const initialConn: Record<string, ConnTestState> = Object.fromEntries((readiness?.systems ?? []).map((s) => [s.systemKey, s.test]));

  if (steps.length === 0) {
    return (
      <main>
        <p className="note"><Link href={`/clients/${params.slug}`}>← {client.name}</Link></p>
        <h1>Guided credential setup</h1>
        <p className="note">
          No systems reference a credential yet. Add systems with secret references first (Edit systems), then
          come back to wire them.
        </p>
      </main>
    );
  }

  return (
    <SetupWizard
      slug={client.slug}
      clientName={client.name}
      steps={steps}
      systemKeys={systemKeys}
      initialConn={initialConn}
      delineaConfigured={delineaConfigured(delineaConfigFromEnv())}
    />
  );
}
