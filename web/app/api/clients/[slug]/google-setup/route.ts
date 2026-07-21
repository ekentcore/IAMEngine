// POST /api/clients/:slug/google-setup — start the automated Google Workspace setup (service account +
//   domain-wide delegation) for ONE client. Client-scope only — no fleet mode.
// GET  /api/clients/:slug/google-setup — the latest client-scoped run's state, for the UI poll. Once
//   the run has landed on a vaulted google-admin credential (done OR a needs_action manual-DWD
//   fallback), auto-triggers the google-workspace connection test exactly once — see
//   ensureGoogleConnTestTriggered's doc comment for why needs_action counts too.
// Mutating (creates a GCP service account + writes a Delinea secret): gated on client.edit_secrets and
// the caller's client scope, and audited — mirrors the m365-setup route's shape.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { currentClientScope, scopeAllows } from "@/lib/auth/client-scope";
import { auditActor, recordAudit } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { buildGoogleSetupDeps } from "@/lib/secrets/setup-google-deps";
import { setupGoogleForClient } from "@/lib/secrets/setup-google-client";
import { startGoogleSetupRun, latestGoogleSetupRun, ensureGoogleConnTestTriggered, cancelGoogleSetupRun } from "@/lib/secrets/google-setup-run";
import { stopAutoSetupJobs } from "@/lib/secrets/setup-cancel";
import { GOOGLE_AUTOSETUP_MARKER } from "@/lib/cases/exclude-m365-autosetup";
import { GOOGLE_OAUTH_SIGNIN_KEY, GOOGLE_DWD_GRANT_KEY } from "@/lib/jobs/adhoc";
import { makeRunnerService } from "@/lib/jobs/runner-service";
import { secretIsSet } from "@/lib/secrets/wiring";

export const dynamic = "force-dynamic";

async function loadClient(slug: string) {
  return db.client.findUnique({ where: { slug }, select: { id: true, slug: true, name: true, delineaFolderId: true } });
}

export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const _g = await guard("client.edit_secrets"); if (_g.res) return _g.res;
  const client = await loadClient(params.slug);
  if (!client) return NextResponse.json({ error: "not found" }, { status: 404 });
  const scope = await currentClientScope(db);
  if (!scopeAllows(scope, client.id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { seedSecretRef?: string; forceRotate?: unknown };
  // The flow always runs off a per-run super-admin login reference (never a stored client secret) —
  // require it here rather than silently failing deep inside the core.
  if (!body.seedSecretRef?.trim()) {
    return NextResponse.json({ error: "provide the super-admin login's Delinea secret id" }, { status: 400 });
  }
  const seedSecretRef = body.seedSecretRef.trim();
  // Operator-requested rotation: force a fresh service-account key even if the existing one is valid,
  // so the vault is re-written complete. Strictly opt-in (an accidental rotation churns credentials).
  const forceRotate = body.forceRotate === true;

  const deps = buildGoogleSetupDeps(db);
  const r = await startGoogleSetupRun(db, {
    client,
    startedBy: auditActor(_g.user, "ui").label,
    seedSecretRef,
    forceRotate,
    runSetup: (onStage, signal) => setupGoogleForClient({ client, seedSecretRef, forceRotate, deps, onStage, signal }),
  });
  if (!r.started) return NextResponse.json({ started: false, reason: r.reason }, { status: 409 });
  await recordAudit("google.setup.start", { user: _g.user, clientId: client.id, detail: { scope: "client", runId: r.id } });
  return NextResponse.json({ started: true, id: r.id });
}

// DELETE /api/clients/:slug/google-setup — cancel this client's in-progress setup run: flip the run +
// row to "cancelled" (durable — the detached closure's writes all respect it), abort the in-process
// signal, and stop the run's in-flight browser jobs (OAuth sign-in / DWD grant) so the runner
// abandons them too. Mirrors the m365-setup route's DELETE.
export async function DELETE(_req: Request, { params }: { params: { slug: string } }) {
  const _g = await guard("client.edit_secrets"); if (_g.res) return _g.res;
  const client = await loadClient(params.slug);
  if (!client) return NextResponse.json({ error: "not found" }, { status: 404 });
  const scope = await currentClientScope(db);
  if (!scopeAllows(scope, client.id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const actor = auditActor(_g.user, "ui:cancel");
  const r = await cancelGoogleSetupRun(db, client.id, { cancelledBy: actor.label });
  if (!r.cancelled) return NextResponse.json({ cancelled: false, reason: r.reason, id: r.id }, { status: 409 });
  const stopped = await stopAutoSetupJobs(db, makeRunnerService(db), {
    marker: GOOGLE_AUTOSETUP_MARKER,
    systemKeys: [GOOGLE_OAUTH_SIGNIN_KEY, GOOGLE_DWD_GRANT_KEY],
    clientId: client.id,
    actor,
  });
  await recordAudit("google.setup.cancel", { user: _g.user, clientId: client.id, detail: { scope: "client", runId: r.id, stoppedJobs: stopped } });
  return NextResponse.json({ cancelled: true, id: r.id, stoppedJobs: stopped });
}

export async function GET(_req: Request, { params }: { params: { slug: string } }) {
  const _g = await guard("client.edit_secrets"); if (_g.res) return _g.res;
  const client = await loadClient(params.slug);
  if (!client) return NextResponse.json({ error: "not found" }, { status: 404 });
  const scope = await currentClientScope(db);
  if (!scopeAllows(scope, client.id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const run = await latestGoogleSetupRun(db, client.id);
  // The per-client scope key makes this THIS client's own run; the single row is trivially "mine".
  const mine = run?.clients.find((c) => c.clientId === client.id);
  if (!run) return NextResponse.json({ run: null });
  if (!mine) {
    // The run row exists but its GoogleSetupRunClient row hasn't been created yet (a brief race right
    // at run start). Report a pending/running client status so the UI keeps polling until it shows up.
    return NextResponse.json({
      run: { id: run.id, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt },
      client: { status: run.status === "running" ? "running" : "pending", stage: null, log: [] },
    });
  }

  // On a successful (or manual-fallback) run, surface WHICH Delinea secret the credential was vaulted
  // as — read back from the client's own Secret wiring (name "google-admin"), which the write step
  // upserts. Only a REAL Delinea id counts (never the REPLACE_ME/""/NOT_NEEDED placeholder).
  let externalId: string | null = null;
  if (mine.status === "done" || mine.status === "needs_action") {
    const sec = await db.secret.findUnique({
      where: { clientId_name: { clientId: client.id, name: "google-admin" } },
      select: { externalId: true },
    });
    externalId = secretIsSet(sec?.externalId) ? sec!.externalId : null;
  }

  const connTest = await ensureGoogleConnTestTriggered(db, makeRunnerService(db), client, { status: run.status, finishedAt: run.finishedAt });

  return NextResponse.json({
    run: { id: run.id, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt },
    client: {
      status: mine.status,
      stage: mine.stage,
      saEmail: mine.saEmail,
      saClientId: mine.saClientId,
      verified: mine.verified,
      wroteCreds: mine.wroteCreds,
      error: mine.error,
      warnings: mine.warnings,
      userAction: mine.userAction,
      skipReason: mine.skipReason,
      log: mine.log,
      externalId,
    },
    connTest,
  });
}
