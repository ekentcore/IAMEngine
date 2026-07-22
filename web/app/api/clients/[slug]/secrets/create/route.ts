// POST /api/clients/:slug/secrets/create { name, values: { <fieldLabel>: value }, label?, folderId?,
//                                          overwriteExternalId? }
// Author a credential IN-APP: the operator types the field values, the app CREATES the secret in the
// client's Delinea (Secret Server) folder, wires the returned id onto the client, and returns it. The
// values are used once for the POST and NEVER persisted or logged — only the reference (id) is stored.
//
// overwriteExternalId: update an EXISTING Delinea secret's fields IN PLACE instead of creating a new
// one, keeping the same id wired. Guarded — the id must be the one currently wired on THIS client for
// THIS name, so it can never clobber another client's (or another name's) secret. Used by the Google
// key tool's "overwrite" path; omitted for a normal create.
//
// Strictly opt-in: refuses (409) with a precise reason when the write config is absent for this
// (client, secret) — a Delinea write account, this client's folder id, and a template id must all be
// present. This keeps the common no-write-config deployment a graceful no-op.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { db } from "@/lib/db";
import { makeClientRepository } from "@/lib/clients/repository";
import { currentClientScope, scopeAllows } from "@/lib/auth/client-scope";
import { recordAudit, auditActor } from "@/lib/auth/audit";
import { createSecret, updateSecretFields, findTemplateIdByName, getDelineaToken, resolveVaultFolderId } from "@/lib/secrets/delinea";
import { SECRET_FIELD_REQUIREMENTS, checkFieldShape } from "@/lib/secrets/field-requirements";
import { delineaWriteConfigured, delineaWriteConfigFromEnv, defaultFieldMap, defaultTemplateName, folderIdFor, templateFor, identitySubfolderName } from "@/lib/secrets/delinea-templates";
import { apiSetupBySecretName } from "@/lib/secrets/api-setup-catalog";
import { probeSecretValues } from "@/lib/secrets/value-probe";
import { secretRunnerReach } from "@/lib/runner/reachability";
import { secretIsSet } from "@/lib/secrets/wiring";

export const dynamic = "force-dynamic";

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");

export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const g = await guard("client.edit_secrets"); if (g.res) return g.res;

  let body: { name?: unknown; values?: unknown; label?: unknown; folderId?: unknown; force?: unknown; overwriteExternalId?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 422 }); }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 422 });
  // The setup-catalog module this secret name vaults for (if any): drives the Delinea subfolder target
  // and the setup-provenance record. Absent for ad-hoc creds not in the guided-setup catalog.
  const moduleEntry = apiSetupBySecretName(name);
  // The folder the credential was actually vaulted into (for the provenance record) — set on a create.
  let vaultedFolderId: string | null = null;
  const overwriteId = typeof body.overwriteExternalId === "string" ? body.overwriteExternalId.trim() : "";
  const conflictCheck = (body as { conflictCheck?: unknown }).conflictCheck === true;
  const values: Record<string, string> = {};
  if (body.values && typeof body.values === "object") {
    for (const [k, v] of Object.entries(body.values as Record<string, unknown>)) {
      if (typeof v === "string") values[k] = v;
      else if (typeof v === "number" || typeof v === "boolean") values[k] = String(v);
    }
  }
  const bodyFolder = typeof body.folderId === "string" ? body.folderId.trim() : "";

  // Scope-gate: an out-of-scope (restricted) client reads as not-found, like the setup page.
  const scope = await currentClientScope(db);
  const client = await db.client.findUnique({ where: { slug: params.slug }, select: { id: true, name: true, primaryDomain: true, delineaFolderId: true } });
  if (!client || !scopeAllows(scope, client.id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Opt-in conflict check (the Google key tool sets it; the guided modal does not, so its behavior is
  // unchanged): if this client already has a REAL Delinea id wired for this name, stop and report it so
  // the caller can ask the operator to overwrite it (re-submit with overwriteExternalId) or create a
  // distinct new one (re-submit with a distinct label). Only when not already an explicit overwrite.
  if (conflictCheck && !overwriteId) {
    const existing = await db.secret.findUnique({ where: { clientId_name: { clientId: client.id, name } }, select: { externalId: true, label: true } });
    if (secretIsSet(existing?.externalId)) {
      return NextResponse.json(
        { conflict: true, existsExternalId: existing!.externalId, existsLabel: existing!.label ?? null, error: `${client.name} already has a ${name} credential wired (Delinea id ${existing!.externalId}).` },
        { status: 409 },
      );
    }
  }

  // Folder: the client's own, else DELINEA_FOLDER_MAP, else a folder id supplied inline in this request
  // (which we persist onto the client so it's remembered for next time).
  let folderId = folderIdFor(params.slug, client.delineaFolderId);
  if (!folderId && bodyFolder) folderId = bodyFolder;

  // Gate — refuse gracefully (409) with exactly what's missing. A known template NAME counts (no env
  // id needed): stock-template secrets (Automation - API etc.) resolve the id live by name below.
  const cap = delineaWriteConfigured({ slug: params.slug, secretName: name, clientFolderId: folderId, allowTemplateByName: true });
  if (!cap.ok) {
    // manualFallback: the app can't write it here, so the UI offers a "create it by hand in Delinea"
    // modal instead of a dead-end error. (422 field-shape / blocking-probe failures below do NOT set
    // this — those mean fix the form or the credential, not go manual.)
    return NextResponse.json({ error: `Can't create this secret in Delinea — configure ${cap.missing.join("; ")}.`, missing: cap.missing, manualFallback: true }, { status: 409 });
  }

  // Validate required fields are present — the SAME shared check the read-side test uses, so the
  // create gate can't drift from what the connector actually needs. The client's primary domain can
  // supply an m365/spanning tenant hint, so those requirements don't false-flag.
  const reqs = SECRET_FIELD_REQUIREMENTS[name] ?? [];
  const hasTenantHint = Boolean(client.primaryDomain && client.primaryDomain.trim());
  const suppliedFields = Object.entries(values).filter(([, v]) => v.trim() !== "").map(([k]) => k);
  const shape = checkFieldShape(name, suppliedFields, { clientHasTenantHint: hasTenantHint });
  if (!shape.ok) {
    return NextResponse.json({ error: `missing required field(s): ${shape.missing.join(", ")}`, missingFields: shape.missing }, { status: 422 });
  }

  // Confirm the credential actually WORKS before we vault it. A BLOCKING prover (m365: the real Entra
  // grant) that fails refuses the write — there's no point storing a credential we just proved can't
  // authenticate. An ADVISORY prover (ad-dc: is the client's own runner reachable) never blocks: the
  // secret must exist before the runner can do the real bind. `force:true` overrides a blocking fail
  // (for a suspected transient/false-negative), and is recorded distinctly in the audit.
  const force = body.force === true;
  const probe = await probeSecretValues(
    name,
    values,
    { clientPrimaryDomain: client.primaryDomain ?? undefined, agentReach: () => secretRunnerReach(db, client.id, name) },
  );
  if (probe.probeable && probe.blocking && probe.ok === false && !force) {
    return NextResponse.json(
      { error: probe.error ?? "the credential failed a live test", hint: probe.hint, probeFailed: true },
      { status: 422 },
    );
  }

  const cfg = delineaWriteConfigFromEnv();
  let token: string;
  try {
    token = await getDelineaToken(cfg);
  } catch (e) {
    return NextResponse.json({ error: `Delinea write auth failed — ${(e as Error).message}`, manualFallback: true }, { status: 502 });
  }

  // The template: an env-configured id wins (per-instance override); else resolve the secret's stock
  // template NAME ("Automation - API" for mimecast/spanning/proofpoint/…) live from Secret Server, so
  // no per-secret template env is needed at all. cap.ok guarantees one of the two paths exists.
  let tmpl = templateFor(name);
  if (!tmpl) {
    const tmplName = defaultTemplateName(name)!;
    const templateId = await findTemplateIdByName(cfg, tmplName, token);
    if (templateId == null) {
      return NextResponse.json(
        { error: `couldn't find a Secret Server template named "${tmplName}" — create/rename it in Delinea, or set its id via DELINEA_TEMPLATE_MAP`, manualFallback: true },
        { status: 502 },
      );
    }
    tmpl = { templateId, fieldMap: defaultFieldMap(name) };
  }

  // Map our field LABELS → Secret Server slugs via the template map (synonyms also accepted as keys).
  // An exact LABEL match wins over a synonym match across ALL requirements: a synonym can legitimately
  // appear in another requirement's anyOf too (spanning's AccountID is both the "account id" canonical
  // name and a login-email fallback the runner honors) — first-synonym-wins would collapse both values
  // onto one slug.
  const fields: Record<string, string> = {};
  for (const [label, val] of Object.entries(values)) {
    if (val.trim() === "") continue;
    let slug = tmpl.fieldMap[label];
    if (!slug) {
      const req =
        reqs.find((r) => norm(r.label) === norm(label)) ??
        reqs.find((r) => r.anyOf.some((syn) => norm(syn) === norm(label)));
      if (req) slug = tmpl.fieldMap[req.label];
    }
    if (slug) fields[slug] = val;
  }
  const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : null;

  let externalId: string;
  let updated = false;
  if (overwriteId) {
    // OVERWRITE IN PLACE. Guard against clobbering an arbitrary secret: the id must be exactly the one
    // currently wired on THIS client for THIS name — an operator with edit_secrets here must not be
    // able to rewrite another client's (or another name's) Delinea secret by passing its id.
    const existing = await db.secret.findUnique({ where: { clientId_name: { clientId: client.id, name } }, select: { externalId: true } });
    if (!existing || existing.externalId !== overwriteId) {
      return NextResponse.json({ error: "the secret to overwrite is not the one currently wired on this client for this name" }, { status: 422 });
    }
    const upd = await updateSecretFields(cfg, overwriteId, fields, token);
    if (!upd.ok) {
      const detail = upd.error ?? upd.results.filter((r) => !r.ok).map((r) => r.error).filter(Boolean).join("; ");
      return NextResponse.json({ error: detail || "Delinea field update failed", manualFallback: true }, { status: 502 });
    }
    externalId = overwriteId;
    updated = true;
  } else {
    // CREATE a new secret. A caller that wants a genuinely distinct entry (the tool's "create new" when
    // one already exists) passes a distinct `label` — createSecret dedups by name in the folder, so the
    // default `${client.name} — ${name}` would otherwise reuse the existing same-named secret.
    const ssName = label ?? `${client.name} — ${name}`;
    // Credentials belong in a client SUBFOLDER (correct team view permissions), NEVER the client ROOT —
    // a secret in the ROOT "can't be viewed" by the team. Target the module's configured subfolder first
    // ("Vendor" for vendor API creds), then "Identity Services" (the identity-cred default); if neither
    // exists we REFUSE rather than vault into the ROOT (the operator creates the subfolder in Delinea
    // first). The stored delineaFolderId stays the ROOT below. See PRs #180/#182 + the setup catalog.
    const subOrder = [moduleEntry?.delineaSubfolder ?? "", identitySubfolderName()].filter((s, i, a) => a.indexOf(s) === i);
    const createFolderId = await resolveVaultFolderId(cfg, folderId!, subOrder, token);
    if (!createFolderId) {
      const tried = subOrder.filter(Boolean).map((s) => `"${s}"`).join(" or ");
      return NextResponse.json(
        {
          error: `Can't create this secret — ${client.name}'s Delinea folder has no ${tried} subfolder to vault it in. Create that subfolder (with the right team view permissions) in Delinea, then retry. Credentials are never written to the client root.`,
          manualFallback: true,
        },
        { status: 409 },
      );
    }
    const result = await createSecret(cfg, { name: ssName, folderId: createFolderId, templateId: tmpl.templateId, fields }, token);
    if (!result.ok || !result.id) {
      return NextResponse.json({ error: result.error ?? "Delinea create failed", manualFallback: true }, { status: 502 });
    }
    vaultedFolderId = createFolderId;
    // Remember the folder we ACTUALLY created in (folderId) — but only when the client had none stored,
    // so an inline folderId in the body can't repoint the client at a folder its secrets aren't in
    // (folderIdFor already prefers the stored/env folder over the body, so `folderId` is the real one).
    if (folderId && !client.delineaFolderId) {
      await db.client.update({ where: { id: client.id }, data: { delineaFolderId: folderId } });
    }
    externalId = result.id;
  }

  // Wire the reference onto the client (reuses the same store the paste-id path uses). For an overwrite
  // this re-affirms the same id (and refreshes the label); for a create it points the client at the new one.
  await makeClientRepository(db).upsertSecrets(client.id, [{ name, externalId, label }]);

  // Setup provenance: record WHICH Delinea credential set this module up (and where), so when the
  // vendor's permissions need changing later an operator can find the exact secret to edit without
  // spelunking the wiring. Only for guided-setup catalog modules (a real "setup"), and best-effort —
  // never fail the create over the provenance write. One current row per (client, module).
  if (moduleEntry) {
    await db.moduleSetupCredential.upsert({
      where: { clientId_moduleKey: { clientId: client.id, moduleKey: moduleEntry.systemKey } },
      update: { delineaSecretId: externalId, delineaFolderId: vaultedFolderId, setBy: auditActor(g.user, "ui").userId, setAt: new Date() },
      create: { clientId: client.id, moduleKey: moduleEntry.systemKey, delineaSecretId: externalId, delineaFolderId: vaultedFolderId, setBy: auditActor(g.user, "ui").userId },
    }).catch(() => {});
  }

  // Audit: names + field slugs (keys) only — NEVER the values. externalId is a reference, not a secret.
  await recordAudit("secret.create", {
    user: g.user,
    clientId: client.id,
    detail: {
      name,
      fields: Object.keys(fields),
      externalId,
      updated,
      templateId: tmpl.templateId,
      // Provenance of the pre-write check: whether a prover ran, its verdict, and whether a blocking
      // failure was force-overridden. Never includes values.
      probe: probe.probeable ? { kind: probe.kind, ok: probe.ok ?? null, forced: force && probe.ok === false } : "none",
    },
  });

  return NextResponse.json({ ok: true, name, externalId, label, updated });
}
