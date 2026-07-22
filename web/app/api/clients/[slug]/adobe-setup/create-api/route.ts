// Adobe Developer Console API-credential auto-setup (browser flow). The guided-setup modal's
// "Automatic (browser)" affordance drives this:
//   POST → dispatch an Adobe console job: the runner signs in, creates/opens the "iam-engine" project,
//          adds the User Management API as an OAuth Server-to-Server credential, and HARVESTS the
//          Client ID / Client Secret / Org ID, returning them in the job result. Returns { jobId }.
//   GET ?jobId= → poll the job's terminal status. On success the harvested credential is VAULTED to
//          Delinea here (operator-authenticated: correct provenance + audit + Delinea write config) and
//          the raw values are SCRUBBED from the persisted job result immediately. Returns { done, ok, externalId }.
//
// SECURITY NOTE: the harvested Client Secret transits through the job result (the runner posts it) and
// sits there only until the first authenticated GET after completion, which vaults it and overwrites
// the result to drop it. A dedicated runner→app harvest endpoint (never persisting it) is the hardening
// follow-up — the same one tracked for Mimecast Phase 2.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { db } from "@/lib/db";
import { currentClientScope, scopeAllows } from "@/lib/auth/client-scope";
import { auditActor, recordAudit } from "@/lib/auth/audit";
import { secretIsSet } from "@/lib/secrets/wiring";
import { dispatchAdobeConsoleJob, ADOBE_CONSOLE_SECRET_NAME } from "@/lib/secrets/dispatch-adobe-console-job";
import { vaultModuleCredential } from "@/lib/secrets/vault-module-credential";
import { findAdobeHarvested, scrubAdobeHarvested } from "@/lib/secrets/adobe-harvest";
import type { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

const TERMINAL = new Set(["succeeded", "failed", "skipped", "manual"]);
const ADOBE_SECRET = "adobe";

async function scrubResult(jobId: string, result: unknown) {
  try {
    await db.job.update({ where: { id: jobId }, data: { result: scrubAdobeHarvested(result) as Prisma.InputJsonValue } });
  } catch { /* best-effort */ }
}

async function resolveClient(slug: string) {
  const scope = await currentClientScope(db);
  const client = await db.client.findUnique({ where: { slug }, select: { id: true, name: true, slug: true, delineaFolderId: true } });
  if (!client || !scopeAllows(scope, client.id)) return null;
  return client;
}

export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const g = await guard("client.edit_secrets"); if (g.res) return g.res;
  const client = await resolveClient(params.slug);
  if (!client) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const consoleSecretRef = typeof body?.consoleSecretRef === "string" ? body.consoleSecretRef.trim() : "";

  // Claim-gate guard: the console login must be reachable (a wired adobe-console secret OR a per-run
  // ref) or the job is unclaimable — refuse up front with actionable guidance.
  if (!consoleSecretRef) {
    const consoleSecret = await db.secret.findUnique({
      where: { clientId_name: { clientId: client.id, name: ADOBE_CONSOLE_SECRET_NAME } },
      select: { externalId: true },
    });
    if (!secretIsSet(consoleSecret?.externalId)) {
      return NextResponse.json(
        { error: "No Adobe Developer Console login is wired. Enter a Delinea secret ID, or wire an adobe-console secret (an Adobe admin email + password, OTP enabled) first. See /help/adobe.", needsConsoleSecret: true },
        { status: 409 },
      );
    }
  }

  const res = await dispatchAdobeConsoleJob({ db, client, signInOnly: false, consoleSecretRef: consoleSecretRef || undefined });
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 502 });
  await recordAudit("adobe.console.create_app.dispatch", { user: g.user, clientId: client.id, jobId: res.jobId, detail: { usedSecretRef: Boolean(consoleSecretRef) } });
  return NextResponse.json({ ok: true, jobId: res.jobId });
}

export async function GET(req: Request, { params }: { params: { slug: string } }) {
  const g = await guard("client.edit_secrets"); if (g.res) return g.res;
  const client = await resolveClient(params.slug);
  if (!client) return NextResponse.json({ error: "not found" }, { status: 404 });

  const jobId = new URL(req.url).searchParams.get("jobId")?.trim();
  if (!jobId) return NextResponse.json({ error: "jobId required" }, { status: 422 });
  const job = await db.job.findUnique({ where: { id: jobId }, select: { id: true, status: true, error: true, result: true, progress: true, case: { select: { clientId: true } } } });
  if (!job || job.case.clientId !== client.id) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (!TERMINAL.has(job.status)) return NextResponse.json({ done: false, status: job.status, stage: (job.progress as { stage?: string } | null)?.stage });

  if (job.status !== "succeeded") {
    return NextResponse.json({ done: true, ok: false, error: job.error || "the Adobe API-credential setup did not complete — see the run screenshot/logs" });
  }

  // Already vaulted on a prior poll (result scrubbed) — return the wired secret id, don't re-vault.
  const alreadyScrubbed = (job.result as { _harvestScrubbed?: boolean } | null)?._harvestScrubbed === true;
  if (alreadyScrubbed) {
    const wired = await db.secret.findUnique({ where: { clientId_name: { clientId: client.id, name: ADOBE_SECRET } }, select: { externalId: true } });
    return NextResponse.json({ done: true, ok: true, externalId: wired?.externalId ?? null, alreadyVaulted: true });
  }

  const harvested = findAdobeHarvested(job.result);
  if (!harvested) {
    return NextResponse.json({ done: true, ok: false, error: "the setup completed but no OAuth Server-to-Server credential was harvested from the console — check the run and re-run, or paste the credential manually." });
  }

  const v = await vaultModuleCredential(db, {
    client,
    secretName: ADOBE_SECRET,
    values: {
      "client id": harvested.clientId,
      "client secret": harvested.clientSecret,
      ...(harvested.orgId ? { "org id (…@AdobeOrg)": harvested.orgId } : {}),
    },
    setBy: auditActor(g.user, "ui").userId,
  });
  // Scrub regardless of vault outcome — the raw secret must not linger. On a vault error the operator
  // can re-run; the credential is regenerable in the console.
  await scrubResult(jobId, job.result);
  if (!v.ok) return NextResponse.json({ done: true, ok: false, error: `harvested the credential but could not vault it: ${v.error}` }, { status: 502 });

  await recordAudit("adobe.console.create_app.vaulted", { user: g.user, clientId: client.id, jobId, detail: { externalId: v.externalId, folderId: v.folderId } });
  return NextResponse.json({ done: true, ok: true, externalId: v.externalId });
}
