// Spanning console API-token auto-setup (browser). The guided-setup modal's "Automatic (browser)" tab:
//   POST → dispatch a Spanning console job: the runner signs into the admin console (M365 SSO), opens
//          Settings → API Token, generates one if absent, and HARVESTS the API Key, returning it in the
//          job result. The modal supplies the (non-secret) login email + derived apiURL + account id.
//          Returns { jobId }.
//   GET ?jobId= → poll terminal status. On success the harvested token is combined with the supplied
//          email/apiURL/account id and VAULTED as the `spanning` secret here (operator-authenticated:
//          correct provenance + audit + Delinea write config), and the raw token is SCRUBBED from the
//          persisted job result immediately. Returns { done, ok, externalId }.
//
// SECURITY NOTE: the harvested API token transits the job result (the runner posts it) and sits there
// only until the first authenticated GET after completion, which vaults it and overwrites the result to
// drop it. A dedicated runner→app harvest endpoint (so it is never persisted) is a hardening follow-up.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { db } from "@/lib/db";
import { currentClientScope, scopeAllows } from "@/lib/auth/client-scope";
import { auditActor, recordAudit } from "@/lib/auth/audit";
import { secretIsSet } from "@/lib/secrets/wiring";
import { dispatchSpanningConsoleJob, SPANNING_CONSOLE_SECRET_NAME } from "@/lib/secrets/dispatch-spanning-console-job";
import { vaultModuleCredential } from "@/lib/secrets/vault-module-credential";
import { findSpanningToken, scrubSpanningToken } from "@/lib/secrets/spanning-harvest";
import type { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

const TERMINAL = new Set(["succeeded", "failed", "skipped", "manual"]);
const SPANNING_SECRET = "spanning";

async function scrubResult(jobId: string, result: unknown) {
  try {
    await db.job.update({ where: { id: jobId }, data: { result: scrubSpanningToken(result) as Prisma.InputJsonValue } });
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
  const loginEmail = typeof body?.loginEmail === "string" ? body.loginEmail.trim() : "";
  const apiUrl = typeof body?.apiUrl === "string" ? body.apiUrl.trim() : "";
  const accountId = typeof body?.accountId === "string" ? body.accountId.trim() : "";
  const consoleUrl = typeof body?.consoleUrl === "string" ? body.consoleUrl.trim() : "";

  // The `spanning` API secret needs a login email + endpoint; the modal derives them (deriveSpanningValues).
  if (!loginEmail || !apiUrl) {
    return NextResponse.json({ error: "provide the login email and pick the service + region (the API URL is derived)" }, { status: 422 });
  }
  // Claim-gate: the console login must be reachable (wired spanning-portal secret OR a per-run ref).
  if (!consoleSecretRef) {
    const consoleSecret = await db.secret.findUnique({
      where: { clientId_name: { clientId: client.id, name: SPANNING_CONSOLE_SECRET_NAME } },
      select: { externalId: true },
    });
    if (!secretIsSet(consoleSecret?.externalId)) {
      return NextResponse.json(
        { error: "No Spanning console login is wired. Enter a Delinea secret ID, or wire a spanning-portal secret (the M365 admin login for the Spanning console) first.", needsConsoleSecret: true },
        { status: 409 },
      );
    }
  }

  const res = await dispatchSpanningConsoleJob({ db, client, signInOnly: false, consoleUrl: consoleUrl || undefined, consoleSecretRef: consoleSecretRef || undefined, loginEmail, apiUrl, accountId });
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 502 });
  await recordAudit("spanning.console.create_api.dispatch", { user: g.user, clientId: client.id, jobId: res.jobId, detail: { usedSecretRef: Boolean(consoleSecretRef) } });
  return NextResponse.json({ ok: true, jobId: res.jobId });
}

export async function GET(req: Request, { params }: { params: { slug: string } }) {
  const g = await guard("client.edit_secrets"); if (g.res) return g.res;
  const client = await resolveClient(params.slug);
  if (!client) return NextResponse.json({ error: "not found" }, { status: 404 });

  const jobId = new URL(req.url).searchParams.get("jobId")?.trim();
  if (!jobId) return NextResponse.json({ error: "jobId required" }, { status: 422 });
  const job = await db.job.findUnique({ where: { id: jobId }, select: { id: true, status: true, error: true, result: true, request: true, progress: true, case: { select: { clientId: true } } } });
  if (!job || job.case.clientId !== client.id) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (!TERMINAL.has(job.status)) return NextResponse.json({ done: false, status: job.status, stage: (job.progress as { stage?: string } | null)?.stage });
  if (job.status !== "succeeded") {
    return NextResponse.json({ done: true, ok: false, error: job.error || "the Spanning API-token setup did not complete — see the run screenshot/logs" });
  }

  // Already vaulted on a prior poll (result scrubbed) — return the wired secret id, don't re-vault.
  const alreadyScrubbed = (job.result as { _harvestScrubbed?: boolean } | null)?._harvestScrubbed === true;
  if (alreadyScrubbed) {
    const wired = await db.secret.findUnique({ where: { clientId_name: { clientId: client.id, name: SPANNING_SECRET } }, select: { externalId: true } });
    return NextResponse.json({ done: true, ok: true, externalId: wired?.externalId ?? null, alreadyVaulted: true });
  }

  const harvested = findSpanningToken(job.result);
  if (!harvested) {
    return NextResponse.json({ done: true, ok: false, error: "the setup completed but no API token was harvested from the console — check the run and re-run, or paste the token manually." });
  }
  // The non-secret derived values were echoed onto the job config at dispatch time.
  const cfg = (job.request as { config?: { loginEmail?: string; apiUrl?: string; accountId?: string } } | null)?.config ?? {};
  const values: Record<string, string> = { "api token": harvested.apiToken };
  if (cfg.loginEmail) values["login email"] = cfg.loginEmail;
  if (cfg.apiUrl) values["region or base url"] = cfg.apiUrl;
  if (cfg.accountId) values["account id"] = cfg.accountId;

  const v = await vaultModuleCredential(db, { client, secretName: SPANNING_SECRET, values, setBy: auditActor(g.user, "ui").userId });
  // Scrub regardless of vault outcome — the raw token must not linger. (The operator can re-run; the
  // token is regenerable in the console.)
  await scrubResult(jobId, job.result);
  if (!v.ok) return NextResponse.json({ done: true, ok: false, error: `harvested the token but could not vault it: ${v.error}` }, { status: 502 });

  await recordAudit("spanning.console.create_api.vaulted", { user: g.user, clientId: client.id, jobId, detail: { externalId: v.externalId, folderId: v.folderId } });
  return NextResponse.json({ done: true, ok: true, externalId: v.externalId });
}
