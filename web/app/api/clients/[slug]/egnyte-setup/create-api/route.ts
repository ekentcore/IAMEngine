// Egnyte console API-credential auto-setup (the browser flow). The guided-setup modal's "Automatic
// (browser)" tab drives this:
//   POST → dispatch a full (signInOnly:false) Egnyte console job: the runner signs into the client's
//          Egnyte admin, harvests a domain API token, and returns it in the job result. Requires the
//          client's Egnyte domain (body.domain). Returns { jobId }.
//   GET ?jobId= → poll to terminal. On success the harvested token (+ the known domain) is VAULTED to
//          Delinea here (operator-authenticated: correct provenance + audit + Delinea write config) and
//          the raw token is SCRUBBED from the persisted job result immediately. Returns { done, ok, externalId }.
//
// The vault is inlined here (mirrors the Zoom vendor PR) so this PR is self-contained and conflict-free;
// a later refactor can unify the per-vendor vault helpers.
//
// SECURITY NOTE: the harvested token transits the job result until the first authenticated GET after
// completion scrubs it. A dedicated runner→app harvest endpoint is the noted hardening follow-up.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { db } from "@/lib/db";
import { currentClientScope, scopeAllows } from "@/lib/auth/client-scope";
import { auditActor, recordAudit } from "@/lib/auth/audit";
import { secretIsSet } from "@/lib/secrets/wiring";
import { dispatchEgnyteConsoleJob, EGNYTE_CONSOLE_SECRET_NAME } from "@/lib/secrets/dispatch-egnyte-console-job";
import { findHarvested, scrubHarvested } from "@/lib/secrets/egnyte-harvest";
import { createSecret, findTemplateIdByName, getDelineaToken, resolveVaultFolderId } from "@/lib/secrets/delinea";
import { delineaWriteConfigured, delineaWriteConfigFromEnv, defaultFieldMap, defaultTemplateName, folderIdFor, templateFor, identitySubfolderName } from "@/lib/secrets/delinea-templates";
import { apiSetupBySecretName } from "@/lib/secrets/api-setup-catalog";
import { SECRET_FIELD_REQUIREMENTS } from "@/lib/secrets/field-requirements";
import { makeClientRepository } from "@/lib/clients/repository";
import type { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

const TERMINAL = new Set(["succeeded", "failed", "skipped", "manual"]);
const EGNYTE_SECRET = "egnyte";
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");

type ClientRow = { id: string; name: string; slug: string; delineaFolderId: string | null };

// Vault the harvested Egnyte credential (domain + token) into Delinea, wire it, and record provenance.
// Inlined P0a vault (mirrors app/api/clients/[slug]/secrets/create/route.ts). Never logs values.
async function vaultEgnyte(client: ClientRow, values: Record<string, string>, setBy: string | null): Promise<{ ok: true; externalId: string; folderId: string } | { ok: false; error: string }> {
  const clientFolderId = folderIdFor(client.slug, client.delineaFolderId);
  const cap = delineaWriteConfigured({ slug: client.slug, secretName: EGNYTE_SECRET, clientFolderId, allowTemplateByName: true });
  if (!cap.ok) return { ok: false, error: `Delinea write not configured — ${cap.missing.join("; ")}` };
  const cfg = delineaWriteConfigFromEnv();
  let token: string;
  try { token = await getDelineaToken(cfg); } catch (e) { return { ok: false, error: `Delinea write auth failed — ${(e as Error).message}` }; }

  let tmpl = templateFor(EGNYTE_SECRET);
  if (!tmpl) {
    const tmplName = defaultTemplateName(EGNYTE_SECRET);
    const templateId = tmplName ? await findTemplateIdByName(cfg, tmplName, token) : null;
    if (templateId == null) return { ok: false, error: `no Secret Server template "${tmplName ?? EGNYTE_SECRET}"` };
    tmpl = { templateId, fieldMap: defaultFieldMap(EGNYTE_SECRET) };
  }
  const reqs = SECRET_FIELD_REQUIREMENTS[EGNYTE_SECRET] ?? [];
  const fields: Record<string, string> = {};
  for (const [label, val] of Object.entries(values)) {
    if (!val || !val.trim()) continue;
    let slug = tmpl.fieldMap[label];
    if (!slug) {
      const req = reqs.find((r) => norm(r.label) === norm(label)) ?? reqs.find((r) => r.anyOf.some((syn) => norm(syn) === norm(label)));
      if (req) slug = tmpl.fieldMap[req.label];
    }
    if (slug) fields[slug] = val;
  }

  const moduleEntry = apiSetupBySecretName(EGNYTE_SECRET);
  const subOrder = [moduleEntry?.delineaSubfolder ?? "", identitySubfolderName()].filter((s, i, a) => s && a.indexOf(s) === i);
  const folderId = clientFolderId ? await resolveVaultFolderId(cfg, clientFolderId, subOrder, token) : null;
  if (!folderId) return { ok: false, error: `no ${subOrder.map((s) => `"${s}"`).join(" or ")} subfolder under ${client.name}'s Delinea folder (credentials are never written to the client root)` };

  const ssName = `${client.name} — ${EGNYTE_SECRET} (auto)`;
  const result = await createSecret(cfg, { name: ssName, folderId, templateId: tmpl.templateId, fields }, token);
  if (!result.ok || !result.id) return { ok: false, error: result.error ?? "Delinea create failed" };
  const externalId = result.id;
  await makeClientRepository(db).upsertSecrets(client.id, [{ name: EGNYTE_SECRET, externalId, label: ssName }]);
  if (moduleEntry) {
    await db.moduleSetupCredential.upsert({
      where: { clientId_moduleKey: { clientId: client.id, moduleKey: moduleEntry.systemKey } },
      update: { delineaSecretId: externalId, delineaFolderId: folderId, setBy, setAt: new Date() },
      create: { clientId: client.id, moduleKey: moduleEntry.systemKey, delineaSecretId: externalId, delineaFolderId: folderId, setBy },
    }).catch(() => {}); // provenance is best-effort — never fail the vault over it
  }
  return { ok: true, externalId, folderId };
}

async function resolveClient(slug: string): Promise<ClientRow | null> {
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
  const egnyteDomain = typeof body?.domain === "string" ? body.domain.trim() : "";
  if (!egnyteDomain) {
    return NextResponse.json({ error: "the client's Egnyte domain is required (the <domain> in https://<domain>.egnyte.com)", needsDomain: true }, { status: 422 });
  }
  const consoleSecretRef = typeof body?.consoleSecretRef === "string" ? body.consoleSecretRef.trim() : "";
  if (!consoleSecretRef) {
    const consoleSecret = await db.secret.findUnique({ where: { clientId_name: { clientId: client.id, name: EGNYTE_CONSOLE_SECRET_NAME } }, select: { externalId: true } });
    if (!secretIsSet(consoleSecret?.externalId)) {
      return NextResponse.json({ error: "No Egnyte console login is wired. Enter a Delinea secret ID, or wire an egnyte-console secret (admin email + password) first.", needsConsoleSecret: true }, { status: 409 });
    }
  }

  const res = await dispatchEgnyteConsoleJob({ db, client, signInOnly: false, egnyteDomain, consoleSecretRef: consoleSecretRef || undefined });
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 502 });
  await recordAudit("egnyte.console.create_app.dispatch", { user: g.user, clientId: client.id, jobId: res.jobId, detail: { egnyteDomain, usedSecretRef: Boolean(consoleSecretRef) } });
  return NextResponse.json({ ok: true, jobId: res.jobId });
}

export async function GET(req: Request, { params }: { params: { slug: string } }) {
  const g = await guard("client.edit_secrets"); if (g.res) return g.res;
  const client = await resolveClient(params.slug);
  if (!client) return NextResponse.json({ error: "not found" }, { status: 404 });

  const jobId = new URL(req.url).searchParams.get("jobId")?.trim();
  if (!jobId) return NextResponse.json({ error: "jobId required" }, { status: 422 });
  const job = await db.job.findUnique({ where: { id: jobId }, select: { id: true, status: true, error: true, result: true, request: true, case: { select: { clientId: true } } } });
  if (!job || job.case.clientId !== client.id) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (!TERMINAL.has(job.status)) return NextResponse.json({ done: false, status: job.status });
  if (job.status !== "succeeded") return NextResponse.json({ done: true, ok: false, error: job.error || "the Egnyte API-token setup did not complete — see the run screenshot/logs" });

  const alreadyScrubbed = (job.result as { _harvestScrubbed?: boolean } | null)?._harvestScrubbed === true;
  if (alreadyScrubbed) {
    const wired = await db.secret.findUnique({ where: { clientId_name: { clientId: client.id, name: EGNYTE_SECRET } }, select: { externalId: true } });
    return NextResponse.json({ done: true, ok: true, externalId: wired?.externalId ?? null, alreadyVaulted: true });
  }

  const harvested = findHarvested(job.result);
  if (!harvested) return NextResponse.json({ done: true, ok: false, error: "the setup completed but no Egnyte API token was harvested — re-run, or paste the token manually." });

  // The domain is a known input — prefer the flow's echo, else the domain the job was dispatched with.
  const dispatchedDomain = (job.request as { config?: { egnyteDomain?: string } } | null)?.config?.egnyteDomain ?? "";
  const domain = harvested.domain || dispatchedDomain;
  if (!domain) return NextResponse.json({ done: true, ok: false, error: "harvested a token but the Egnyte domain was lost — re-run the setup." }, { status: 502 });

  const v = await vaultEgnyte(client, { "egnyte domain": domain, "api token": harvested.token }, auditActor(g.user, "ui").userId);
  // Scrub regardless of vault outcome — the raw token must not linger.
  try { await db.job.update({ where: { id: jobId }, data: { result: scrubHarvested(job.result) as Prisma.InputJsonValue } }); } catch { /* best-effort */ }
  if (!v.ok) return NextResponse.json({ done: true, ok: false, error: `harvested the token but could not vault it: ${v.error}` }, { status: 502 });

  await recordAudit("egnyte.console.create_app.vaulted", { user: g.user, clientId: client.id, jobId, detail: { externalId: v.externalId, folderId: v.folderId } });
  return NextResponse.json({ done: true, ok: true, externalId: v.externalId });
}
