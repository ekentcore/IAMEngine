// Vault a freshly-provisioned Google Workspace service-account key back into Delinea under the
// client, as the `google-admin` secret. This is the Google analog of write-m365-app.ts — same
// decision order, same write-path primitives (createSecret, updateSecretFields, delineaWriteConfigured,
// templateFor/folderIdFor/identitySubfolderName), same "(auto)" wiring-label mechanism — but simpler:
// GoogleProvision has only two credStates (no "unverified", no created/gaps/verified reconciliation),
// and the Delinea secret NAME is a fixed literal ("Google API - IAM Engine"), not a per-client name.
//
//   1. reconcile — provisionGoogleWorkspace only returns keyBase64 when it ISSUED a new key this run
//      (a "kept existing, still valid" run returns credState "kept-valid" and no key). Nothing new to
//      write -> the caller keeps whatever is already vaulted.
//   2. gate — the same delineaWriteConfigured() check the manual create route uses (write account +
//      folder + template all present for this client).
//   3. map our field LABELS -> Secret Server slugs via templateFor("google-admin").fieldMap. The
//      labels are deliberately spelled exactly like the stock "Automation - API" field names
//      (ClientID/ClientSecret/accountid/apiURL — see field-requirements.ts), so the default field map
//      round-trips googleLabeledValues() without needing an operator-supplied override.
//   4. createSecret (find-or-create) to get an id, then updateSecretFields to push the current values.
//   5. persist the vault REFERENCE (never the key) onto the client, self-learning the folder id.
//
// Secret hygiene: keyBase64 (the one-time service-account key material) is used only to build the
// Delinea field values — it is never interpolated into an error string or pushed onto `actions`.
import type { PrismaClient } from "@prisma/client";
import { createSecret, updateSecretFields, getDelineaToken, findChildFolderByName, type Fetcher } from "./delinea";
import { delineaWriteConfigured, delineaWriteConfigFromEnv, folderIdFor, templateFor, identitySubfolderName } from "./delinea-templates";
import { secretIsSet } from "./wiring";
import { makeClientRepository } from "@/lib/clients/repository";
import type { GoogleProvision } from "./provision-google-workspace";

export const GOOGLE_SECRET_NAME = "Google API - IAM Engine";

// The logical secret key the systems reference (systems' secretNames / the client's Secrets panel),
// and the row this module reads/writes on Client Secret.
const WIRE_NAME = "google-admin";

export type WriteGoogleClientInput = { id: string; slug: string; name: string; delineaFolderId: string | null };

type Env = Record<string, string | undefined>;

export type WriteGoogleInput = {
  db: PrismaClient;
  client: WriteGoogleClientInput;
  provision: GoogleProvision;
  impersonate: string;
  customerId?: string;
  // Injectable for tests — never required by real callers (default to process.env / global fetch).
  fetch?: Fetcher;
  env?: Env;
};

export type WriteGoogleResult =
  | { ok: true; externalId: string; actions: string[] }
  | { ok: false; stranded?: boolean; error: string; actions: string[] };

// The client Secrets-panel wiring label, stamped so it's clear the credential was auto-provisioned.
// Mirrors write-m365-app.ts's autoLabel: preserves any existing label, appends "(auto)" once.
function autoGoogleLabel(existing?: string | null): string {
  const base = (existing ?? "").trim();
  if (!base) return "Google service account (auto)";
  return /\(auto\)/i.test(base) ? base : `${base} (auto)`;
}

// The Secret Server field LABELS (spelled exactly like the stock "Automation - API" field names —
// see field-requirements.ts's "google-admin" entry) mapped to the value that fills them.
export function googleLabeledValues(p: { keyBase64: string; saEmail: string; impersonate: string; customerId?: string }): Record<string, string> {
  return {
    ClientID: p.customerId ?? "my_customer",
    ClientSecret: p.keyBase64,
    accountid: p.saEmail,
    apiURL: p.impersonate,
  };
}

export async function writeGoogleWorkspaceCreds(input: WriteGoogleInput): Promise<WriteGoogleResult> {
  const { db, client, provision, impersonate, customerId } = input;
  const fetcher = input.fetch;
  const env = input.env ?? process.env;
  const actions: string[] = [];

  const existingRow = await db.secret.findUnique({
    where: { clientId_name: { clientId: client.id, name: WIRE_NAME } },
    select: { externalId: true, label: true },
  });

  if (provision.credState === "kept-valid") {
    // Genuinely nothing new to write UNLESS the vault has no row for this client at all (or only a
    // REPLACE_ME/"" placeholder — the seed default) — the stranded/unrecoverable case: the service
    // account reports a valid key, but we hold none of it. The one-time key material from whenever it
    // WAS issued cannot be re-read; the only fix is to rotate/re-issue.
    if (!secretIsSet(existingRow?.externalId)) {
      return {
        ok: false,
        stranded: true,
        error:
          "the service account reports a valid key but none is vaulted — it was likely issued on a prior run whose vault write failed; the key must be rotated/re-issued (the prior one-time key material is unrecoverable)",
        actions,
      };
    }
    // Nothing new to vault, but stamp the "(auto)" wiring label if it isn't already — idempotent, and
    // makes zero Delinea network calls (no cert-completeness analog here — a Google key is one field).
    const stamped = autoGoogleLabel(existingRow!.label);
    if (stamped !== (existingRow!.label ?? "")) {
      await makeClientRepository(db).upsertSecrets(client.id, [{ name: WIRE_NAME, externalId: existingRow!.externalId, label: stamped }]);
      actions.push("stamped the (auto) wiring label");
    }
    return { ok: true, externalId: existingRow!.externalId, actions };
  }

  // From here: provision.credState === "issued" — a new key was minted this run and must be vaulted
  // (it's the only copy Google will ever hand back).
  if (!provision.keyBase64) {
    return { ok: false, error: "provision reported credState 'issued' but no key material was returned", actions };
  }

  // Gate: the app can only write when a write account + this client's folder + a template id for
  // this secret are all configured. Same check the manual create route uses.
  const cap = delineaWriteConfigured({ slug: client.slug, secretName: WIRE_NAME, clientFolderId: client.delineaFolderId, env });
  if (!cap.ok) {
    return { ok: false, error: `Delinea write not configured — ${cap.missing.join("; ")}`, actions };
  }

  const folderId = folderIdFor(client.slug, client.delineaFolderId, env)!; // cap.ok guarantees non-null
  const tmpl = templateFor(WIRE_NAME, env)!; // cap.ok guarantees a template

  // Map labels -> Secret Server slugs, skipping any label whose value is undefined this run.
  const labeled = googleLabeledValues({ keyBase64: provision.keyBase64, saEmail: provision.saEmail, impersonate, customerId });
  const fields: Record<string, string> = {};
  for (const [label, value] of Object.entries(labeled)) {
    if (value === undefined) continue;
    const slug = tmpl.fieldMap[label];
    if (slug) fields[slug] = value;
  }

  const cfg = delineaWriteConfigFromEnv(env);
  let token: string;
  try {
    token = await getDelineaToken(cfg, fetcher);
  } catch (e) {
    return { ok: false, error: `Delinea write auth failed — ${(e as Error).message}`, actions };
  }

  let externalId: string;
  // Only a REAL Delinea id counts as "already vaulted" — a REPLACE_ME/"" placeholder falls through to
  // CREATE, minting a real secret and wiring its real id over the placeholder (never PUT to it).
  if (secretIsSet(existingRow?.externalId)) {
    // Already vaulted — update the known secret in place. No name search, no create call.
    externalId = existingRow!.externalId;
    const updated = await updateSecretFields(cfg, externalId, fields, token, fetcher);
    if (!updated.ok) {
      return { ok: false, error: updated.error ?? "Delinea field update failed", actions };
    }
    actions.push(`updated Delinea secret ${externalId}`);
  } else {
    // No local row — create it fresh, named EXACTLY "Google API - IAM Engine" (a fixed literal name,
    // unlike m365's per-client name — each client's own Identity Services subfolder gets its own copy).
    const subName = identitySubfolderName(env);
    const createFolderId = (subName && (await findChildFolderByName(cfg, folderId, subName, token, fetcher))) || folderId;
    const created = await createSecret(cfg, { name: GOOGLE_SECRET_NAME, folderId: createFolderId, templateId: tmpl.templateId, fields }, token, fetcher);
    if (!created.ok || !created.id) {
      return { ok: false, error: created.error ?? "Delinea create failed", actions };
    }
    externalId = created.id;
    actions.push(`created Delinea secret ${externalId}`);
    const updated = await updateSecretFields(cfg, externalId, fields, token, fetcher);
    if (!updated.ok) {
      return { ok: false, error: updated.error ?? "Delinea field update failed", actions };
    }
  }

  // Persist the vault REFERENCE (never the key): self-learn the folder if the client had none, then
  // wire the secret id onto the client with the "(auto)" wiring label.
  if (folderId && !client.delineaFolderId) {
    await db.client.update({ where: { id: client.id }, data: { delineaFolderId: folderId } });
    actions.push("self-learned the client's Delinea folder id");
  }
  await makeClientRepository(db).upsertSecrets(client.id, [{ name: WIRE_NAME, externalId, label: autoGoogleLabel(existingRow?.label) }]);
  actions.push(`wired ${WIRE_NAME}`);

  return { ok: true, externalId, actions };
}
