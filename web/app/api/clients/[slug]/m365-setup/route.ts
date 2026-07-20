// POST /api/clients/:slug/m365-setup — start the automated M365 app-registration setup for ONE client.
// GET  /api/clients/:slug/m365-setup — the latest client-scoped run's state, for the UI poll.
// Mutating (creates an Entra app registration + writes a Delinea secret): gated on client.edit_secrets
// and the caller's client scope, and audited.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { currentClientScope, scopeAllows } from "@/lib/auth/client-scope";
import { auditActor, recordAudit } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { buildSetupDeps } from "@/lib/secrets/setup-m365-deps";
import { setupM365ForClient } from "@/lib/secrets/setup-m365-client";
import { startM365SetupRun, latestM365SetupRun } from "@/lib/secrets/m365-setup-run";

export const dynamic = "force-dynamic";

async function loadClient(slug: string) {
  return db.client.findUnique({ where: { slug }, select: { id: true, slug: true, name: true, primaryDomain: true, delineaFolderId: true } });
}

export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const _g = await guard("client.edit_secrets"); if (_g.res) return _g.res;
  const client = await loadClient(params.slug);
  if (!client) return NextResponse.json({ error: "not found" }, { status: 404 });
  const scope = await currentClientScope(db);
  if (!scopeAllows(scope, client.id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { gaSecretRef?: string };
  // The per-client flow always runs off a per-run GA login reference (never a stored client secret) —
  // require it here rather than silently falling back to the fleet path's persisted-secret behavior.
  if (!body.gaSecretRef?.trim()) {
    return NextResponse.json({ error: "provide the Global Admin login's Delinea secret id" }, { status: 422 });
  }
  const gaSecretRef = body.gaSecretRef.trim();

  const deps = buildSetupDeps(db);
  const r = await startM365SetupRun(db, {
    scope: `client:${client.id}`,
    targets: [{ id: client.id, slug: client.slug, name: client.name, primaryDomain: client.primaryDomain, delineaFolderId: client.delineaFolderId, gaSecretRef }],
    startedBy: auditActor(_g.user, "ui").label,
  }, {
    runSetup: (c, tenant, ref) => setupM365ForClient({ client: c, tenant, gaSecretRef: ref }, deps),
    hasGlobalAdminSecret: deps.hasGlobalAdminSecret,
  });
  if (!r.started) return NextResponse.json({ started: false, reason: r.reason, id: r.id }, { status: 409 });
  await recordAudit("m365.setup.start", { user: _g.user, clientId: client.id, detail: { scope: "client", runId: r.id } });
  return NextResponse.json({ started: true, id: r.id });
}

export async function GET(_req: Request, { params }: { params: { slug: string } }) {
  const _g = await guard("client.edit_secrets"); if (_g.res) return _g.res;
  const client = await loadClient(params.slug);
  if (!client) return NextResponse.json({ error: "not found" }, { status: 404 });
  const scope = await currentClientScope(db);
  if (!scopeAllows(scope, client.id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const run = await latestM365SetupRun(db, `client:${client.id}`);
  // The per-client scope key makes this THIS client's own run; the single row is trivially "mine".
  const mine = run?.clients.find((c) => c.clientId === client.id);
  if (!run || !mine) return NextResponse.json({ run: null });
  return NextResponse.json({
    run: { id: run.id, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt },
    client: { status: mine.status, stage: mine.stage, appId: mine.appId, verified: mine.verified, wroteCreds: mine.wroteCreds, error: mine.error, warnings: mine.warnings, userCode: mine.userCode, verificationUri: mine.verificationUri, skipReason: mine.skipReason },
  });
}
