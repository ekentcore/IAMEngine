// POST /api/clients/:slug/secrets/create { name, values: { <fieldLabel>: value }, label?, folderId? }
// Author a credential IN-APP: the operator types the field values, the app CREATES the secret in the
// client's Delinea (Secret Server) folder, wires the returned id onto the client, and returns it. The
// values are used once for the POST and NEVER persisted or logged — only the reference (id) is stored.
//
// Strictly opt-in: refuses (409) with a precise reason when the write config is absent for this
// (client, secret) — a Delinea write account, this client's folder id, and a template id must all be
// present. This keeps the common no-write-config deployment a graceful no-op.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { db } from "@/lib/db";
import { makeClientRepository } from "@/lib/clients/repository";
import { currentClientScope, scopeAllows } from "@/lib/auth/client-scope";
import { recordAudit } from "@/lib/auth/audit";
import { createSecret, getDelineaToken } from "@/lib/secrets/delinea";
import { SECRET_FIELD_REQUIREMENTS, checkFieldShape } from "@/lib/secrets/field-requirements";
import { delineaWriteConfigured, delineaWriteConfigFromEnv, folderIdFor, templateFor } from "@/lib/secrets/delinea-templates";
import { probeSecretValues } from "@/lib/secrets/value-probe";
import { secretRunnerReach } from "@/lib/runner/reachability";

export const dynamic = "force-dynamic";

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");

export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const g = await guard("client.edit_secrets"); if (g.res) return g.res;

  let body: { name?: unknown; values?: unknown; label?: unknown; folderId?: unknown; force?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 422 }); }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 422 });
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

  // Folder: the client's own, else DELINEA_FOLDER_MAP, else a folder id supplied inline in this request
  // (which we persist onto the client so it's remembered for next time).
  let folderId = folderIdFor(params.slug, client.delineaFolderId);
  if (!folderId && bodyFolder) folderId = bodyFolder;

  // Gate — refuse gracefully (409) with exactly what's missing.
  const cap = delineaWriteConfigured({ slug: params.slug, secretName: name, clientFolderId: folderId });
  if (!cap.ok) {
    return NextResponse.json({ error: `Can't create this secret in Delinea — configure ${cap.missing.join("; ")}.`, missing: cap.missing }, { status: 409 });
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

  // Map our field LABELS → Secret Server slugs via the template map (synonyms also accepted as keys).
  const tmpl = templateFor(name)!; // cap.ok guarantees a template
  const fields: Record<string, string> = {};
  for (const [label, val] of Object.entries(values)) {
    if (val.trim() === "") continue;
    let slug = tmpl.fieldMap[label];
    if (!slug) {
      // allow a synonym as the incoming key (find the requirement whose label/synonym it matches)
      const req = reqs.find((r) => norm(r.label) === norm(label) || r.anyOf.some((syn) => norm(syn) === norm(label)));
      if (req) slug = tmpl.fieldMap[req.label];
    }
    if (slug) fields[slug] = val;
  }

  const cfg = delineaWriteConfigFromEnv();
  let token: string;
  try {
    token = await getDelineaToken(cfg);
  } catch (e) {
    return NextResponse.json({ error: `Delinea write auth failed — ${(e as Error).message}` }, { status: 502 });
  }
  const ssName = typeof body.label === "string" && body.label.trim() ? body.label.trim() : `${client.name} — ${name}`;
  const result = await createSecret(cfg, { name: ssName, folderId: folderId!, templateId: tmpl.templateId, fields }, token);
  if (!result.ok || !result.id) {
    return NextResponse.json({ error: result.error ?? "Delinea create failed" }, { status: 502 });
  }

  // Remember the folder we ACTUALLY created in (folderId) — but only when the client had none stored,
  // so an inline folderId in the body can't repoint the client at a folder its secrets aren't in
  // (folderIdFor already prefers the stored/env folder over the body, so `folderId` is the real one).
  if (folderId && !client.delineaFolderId) {
    await db.client.update({ where: { id: client.id }, data: { delineaFolderId: folderId } });
  }

  // Wire the created reference onto the client (reuses the same store the paste-id path uses).
  const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : null;
  await makeClientRepository(db).upsertSecrets(client.id, [{ name, externalId: result.id, label }]);

  // Audit: names + field slugs (keys) only — NEVER the values. externalId is a reference, not a secret.
  await recordAudit("secret.create", {
    user: g.user,
    clientId: client.id,
    detail: {
      name,
      fields: Object.keys(fields),
      externalId: result.id,
      templateId: tmpl.templateId,
      // Provenance of the pre-write check: whether a prover ran, its verdict, and whether a blocking
      // failure was force-overridden. Never includes values.
      probe: probe.probeable ? { kind: probe.kind, ok: probe.ok ?? null, forced: force && probe.ok === false } : "none",
    },
  });

  return NextResponse.json({ ok: true, name, externalId: result.id, label });
}
