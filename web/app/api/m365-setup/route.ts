// POST /api/m365-setup — start the fleet-wide automated M365 setup sweep (or a dry-run eligibility
// preview). Mutating across the fleet: requires client.edit_secrets AND all-clients access.
// GET  /api/m365-setup — the latest fleet run's state + per-client roll-up, for the page poll.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { fleetWideAccess } from "@/lib/auth/fleet-access";
import { scopeAllows } from "@/lib/auth/client-scope";
import { auditActor, recordAudit } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { buildSetupDeps } from "@/lib/secrets/setup-m365-deps";
import { setupM365ForClient } from "@/lib/secrets/setup-m365-client";
import { startM365SetupRun, latestM365SetupRun, cancelM365SetupRun } from "@/lib/secrets/m365-setup-run";
import { stopAutoSetupJobs } from "@/lib/secrets/setup-cancel";
import { M365_AUTOSETUP_MARKER } from "@/lib/cases/exclude-m365-autosetup";
import { ENTRA_DEVICECODE_KEY } from "@/lib/jobs/adhoc";
import { makeRunnerService } from "@/lib/jobs/runner-service";

export const dynamic = "force-dynamic";

export async function POST(req: Request, _ctx: unknown) {
  const _g = await guard("client.edit_secrets"); if (_g.res) return _g.res;
  const access = await fleetWideAccess(db, _g.user.id);
  if (!access.ok) return NextResponse.json({ error: access.reason }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { dryRun?: boolean };
  // Clients that CAN be set up: those with a wired m365-global-admin GA-login secret (the runner needs
  // it to sign in). Non-archived only. fleetWideAccess requires all-clients MODE, but a restricted
  // client still needs an explicit grant — filter by scopeAllows so a restricted client the operator
  // wasn't granted is never provisioned (F1).
  const secrets = await db.secret.findMany({
    where: { name: "m365-global-admin", client: { archivedAt: null } },
    select: { client: { select: { id: true, slug: true, name: true, primaryDomain: true, delineaFolderId: true } } },
    orderBy: { client: { name: "asc" } },
  });
  const targets = secrets.map((s) => s.client).filter((c) => scopeAllows(access.scope, c.id));

  const deps = buildSetupDeps(db);
  const r = await startM365SetupRun(db, {
    scope: "fleet",
    targets,
    dryRun: Boolean(body.dryRun),
    startedBy: auditActor(_g.user, "ui").label,
    startedById: auditActor(_g.user, "ui").userId,
  }, {
    // Fleet path never carries a gaSecretRef — undefined keeps the persisted-secret path in setupM365ForClient.
    runSetup: (c, tenant, _ref, onStage, signal) => setupM365ForClient({ client: c, tenant, signal }, { ...deps, onStage }),
    hasGlobalAdminSecret: deps.hasGlobalAdminSecret,
  });
  if (!r.started) return NextResponse.json({ started: false, reason: r.reason, id: r.id }, { status: 409 });
  await recordAudit("m365.setup.start", { user: _g.user, detail: { scope: "fleet", dryRun: Boolean(body.dryRun), targets: targets.length, runId: r.id } });
  return NextResponse.json({ started: true, id: r.id, targets: targets.length });
}

// DELETE /api/m365-setup — cancel the in-progress fleet sweep. No clientId filter on the job stop:
// the cross-family start guards mean every in-flight entra-devicecode job belongs to this run.
export async function DELETE(_req: Request, _ctx: unknown) {
  const _g = await guard("client.edit_secrets"); if (_g.res) return _g.res;
  const access = await fleetWideAccess(db, _g.user.id);
  if (!access.ok) return NextResponse.json({ error: access.reason }, { status: 403 });

  const actor = auditActor(_g.user, "ui:cancel");
  const r = await cancelM365SetupRun(db, "fleet", { cancelledBy: actor.label });
  if (!r.cancelled) return NextResponse.json({ cancelled: false, reason: r.reason, id: r.id }, { status: 409 });
  const stopped = await stopAutoSetupJobs(db, makeRunnerService(db), {
    marker: M365_AUTOSETUP_MARKER,
    systemKeys: [ENTRA_DEVICECODE_KEY],
    actor,
  });
  await recordAudit("m365.setup.cancel", { user: _g.user, detail: { scope: "fleet", runId: r.id, stoppedJobs: stopped } });
  return NextResponse.json({ cancelled: true, id: r.id, stoppedJobs: stopped });
}

export async function GET(_req: Request, _ctx: unknown) {
  const _g = await guard("client.edit_secrets"); if (_g.res) return _g.res;
  const access = await fleetWideAccess(db, _g.user.id);
  if (!access.ok) return NextResponse.json({ error: access.reason }, { status: 403 });
  const run = await latestM365SetupRun(db, "fleet");
  if (!run) return NextResponse.json({ run: null });
  return NextResponse.json({
    run: { id: run.id, status: run.status, dryRun: run.dryRun, startedAt: run.startedAt, finishedAt: run.finishedAt, total: run.total, completed: run.completed, succeeded: run.succeeded, skipped: run.skipped, failed: run.failed, error: run.error },
    clients: run.clients.map((c) => ({ slug: c.slug, name: c.name, status: c.status, stage: c.stage, appId: c.appId, verified: c.verified, error: c.error, warnings: c.warnings, skipReason: c.skipReason })),
  });
}
