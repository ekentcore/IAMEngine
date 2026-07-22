// Vault a harvested/collected module credential into Delinea and record it — the shared write path for
// automated setups whose credential is minted by a BROWSER flow (e.g. Mimecast console Phase 2) rather
// than typed into the guided form. It mirrors the vault sequence in
// app/api/clients/[slug]/secrets/create/route.ts (template → field-slug map → Vendor-subfolder chain →
// createSecret → wire → ModuleSetupCredential provenance), factored out so the browser-harvest result
// handler doesn't reimplement it. (The paste form still uses the route directly; a later refactor could
// point it here too — kept additive for now to avoid touching that route.)
import type { PrismaClient } from "@prisma/client";
import { createSecret, findTemplateIdByName, getDelineaToken, resolveVaultFolderId } from "./delinea";
import { delineaWriteConfigured, delineaWriteConfigFromEnv, defaultFieldMap, defaultTemplateName, folderIdFor, templateFor, identitySubfolderName } from "./delinea-templates";
import { apiSetupBySecretName } from "./api-setup-catalog";
import { SECRET_FIELD_REQUIREMENTS } from "./field-requirements";
import { makeClientRepository } from "@/lib/clients/repository";

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");

export type VaultModuleInput = {
  client: { id: string; name: string; slug: string; delineaFolderId: string | null };
  secretName: string;                 // the module's secret name (= its moduleKey), e.g. "mimecast"
  values: Record<string, string>;     // field LABEL → value (labels/synonyms from field-requirements)
  setBy: string | null;               // userId to stamp on the provenance row (null for a runner-context write)
  label?: string;                     // optional Delinea secret name; defaults to `${client.name} — ${secretName}`
};

export type VaultModuleResult =
  | { ok: true; externalId: string; folderId: string }
  | { ok: false; error: string; code: "write_not_configured" | "no_folder" | "delinea" };

// Create the Delinea secret, wire it onto the client, and record setup provenance. Never logs values.
export async function vaultModuleCredential(db: PrismaClient, input: VaultModuleInput): Promise<VaultModuleResult> {
  const { client, secretName, values, setBy } = input;
  const clientFolderId = folderIdFor(client.slug, client.delineaFolderId);
  const cap = delineaWriteConfigured({ slug: client.slug, secretName, clientFolderId, allowTemplateByName: true });
  if (!cap.ok) return { ok: false, error: `Delinea write not configured — ${cap.missing.join("; ")}`, code: "write_not_configured" };

  const cfg = delineaWriteConfigFromEnv();
  let token: string;
  try { token = await getDelineaToken(cfg); } catch (e) { return { ok: false, error: `Delinea write auth failed — ${(e as Error).message}`, code: "delinea" }; }

  // Template: env id, else resolve the stock "Automation - API" name live.
  let tmpl = templateFor(secretName);
  if (!tmpl) {
    const tmplName = defaultTemplateName(secretName);
    const templateId = tmplName ? await findTemplateIdByName(cfg, tmplName, token) : null;
    if (templateId == null) return { ok: false, error: `no Secret Server template "${tmplName ?? secretName}"`, code: "delinea" };
    tmpl = { templateId, fieldMap: defaultFieldMap(secretName) };
  }

  // Map field LABELS → template slugs (exact label wins over a synonym), identical to the create route.
  const reqs = SECRET_FIELD_REQUIREMENTS[secretName] ?? [];
  const fields: Record<string, string> = {};
  for (const [label, val] of Object.entries(values)) {
    if (!val || val.trim() === "") continue;
    let slug = tmpl.fieldMap[label];
    if (!slug) {
      const req = reqs.find((r) => norm(r.label) === norm(label)) ?? reqs.find((r) => r.anyOf.some((syn) => norm(syn) === norm(label)));
      if (req) slug = tmpl.fieldMap[req.label];
    }
    if (slug) fields[slug] = val;
  }

  // Folder: the module's configured subfolder ("Vendor" for vendor creds) then "Identity Services";
  // refuse rather than write to the client ROOT (unviewable).
  const moduleEntry = apiSetupBySecretName(secretName);
  const subOrder = [moduleEntry?.delineaSubfolder ?? "", identitySubfolderName()].filter((s, i, a) => s && a.indexOf(s) === i);
  const folderId = clientFolderId ? await resolveVaultFolderId(cfg, clientFolderId, subOrder, token) : null;
  if (!folderId) return { ok: false, error: `no ${subOrder.map((s) => `"${s}"`).join(" or ")} subfolder under ${client.name}'s Delinea folder to vault into (credentials are never written to the client root)`, code: "no_folder" };

  const ssName = input.label?.trim() || `${client.name} — ${secretName} (auto)`;
  const result = await createSecret(cfg, { name: ssName, folderId, templateId: tmpl.templateId, fields }, token);
  if (!result.ok || !result.id) return { ok: false, error: result.error ?? "Delinea create failed", code: "delinea" };
  const externalId = result.id;

  await makeClientRepository(db).upsertSecrets(client.id, [{ name: secretName, externalId, label: ssName }]);

  if (moduleEntry) {
    await db.moduleSetupCredential.upsert({
      where: { clientId_moduleKey: { clientId: client.id, moduleKey: moduleEntry.systemKey } },
      update: { delineaSecretId: externalId, delineaFolderId: folderId, setBy, setAt: new Date() },
      create: { clientId: client.id, moduleKey: moduleEntry.systemKey, delineaSecretId: externalId, delineaFolderId: folderId, setBy },
    }).catch(() => {});
  }
  return { ok: true, externalId, folderId };
}
