// Phase 3: write a freshly-provisioned Entra app registration's credentials back into Delinea under
// the client, as the `m365-admin` secret (extended with cert fields — see field-requirements.ts).
//
// Orchestrates the write-path primitives that already exist (createSecret, updateSecretFields, the
// delineaWriteConfigured gate, the value probe) rather than adding new Delinea plumbing:
//   1. reconcile — provisionM365App only returns clientSecret/certBase64 when it ISSUED a new one this
//      run (a "kept existing, still valid" run returns neither). Nothing new -> nothing to write; the
//      caller keeps whatever is already vaulted.
//   2. validate — a newly issued client secret is proven against Entra (the same client-credentials
//      grant the runner performs) BEFORE it's vaulted. A cert-only issue has no analogous cheap probe
//      here, so it's skipped; the runner's own connection test verifies it later.
//   3. gate — the same delineaWriteConfigured() check the manual create route uses (write account +
//      folder + template all present for this client/secret).
//   4. map our field LABELS -> Secret Server slugs via templateFor().fieldMap, writing only the labels
//      this provision run actually has values for (never an undefined value).
//   5. createSecret (find-or-create) to get an id, then updateSecretFields to push the current values —
//      covers both "brand new secret" and "secret already existed" with one write path.
//   6. persist the vault REFERENCE (never a value) onto the client, self-learning the folder id.
//
// Web-only. db/fetch/env are injected so this is fully unit-testable with no real Delinea/network —
// the dev environment lacks DELINEA_WRITE_*, so this path is unit-tested only here and live-validated
// by the operator once a write account + folder + template are configured.
import type { PrismaClient } from "@prisma/client";
import { createSecret, updateSecretFields, getDelineaToken, findChildFolderByName, type Fetcher } from "./delinea";
import { delineaWriteConfigured, delineaWriteConfigFromEnv, folderIdFor, templateFor, identitySubfolderName } from "./delinea-templates";
import { probeEntraClientCredentials, type EntraProbe } from "./m365-credential";
import { secretIsSet } from "./wiring";
import { makeClientRepository } from "@/lib/clients/repository";
import type { ProvisionResult } from "./provision-m365-app";

export type WriteClientInput = { id: string; slug: string; name: string; delineaFolderId?: string | null; primaryDomain?: string | null };
export type WriteInput = {
  client: WriteClientInput;
  provision: ProvisionResult;
  secretName?: string /* default "m365-admin" */;
  // Whether this credential is SUPPOSED to carry a certificate (default true). When the operator set up
  // the app client-secret-only (no Exchange), an empty cert slug in the vault is expected — NOT the
  // half-vaulted/stranded case — so the completeness check below is skipped.
  expectCert?: boolean;
};

type Env = Record<string, string | undefined>;
export type WriteDeps = {
  db: PrismaClient;
  fetch?: Fetcher;
  env?: Env;
  // Injectable for tests — the retry-with-backoff below awaits this between propagation-retry attempts.
  sleep?: (ms: number) => Promise<void>;
};

export type WriteResult = {
  ok: boolean;
  externalId?: string;
  created?: boolean;
  updated?: boolean;
  wroteCreds: boolean;
  error?: string;
  hint?: string;
  // The app registration reports a valid credential (credState "kept-valid") but the vault holds
  // nothing for it — the stranded/unrecoverable case (see credState doc + Finding 1). Never ok:true.
  stranded?: boolean;
  // Optional-field write failures that did NOT fail the run (e.g. a password-only template legitimately
  // has no certificate slug) — surfaced so an operator can see what quietly didn't get vaulted.
  warnings?: string[];
};

// The client Secrets-panel wiring label, stamped so it's clear the credential was auto-provisioned.
// Preserves any existing label and appends " (auto)" once; a blank/none label gets a descriptive default.
export function autoLabel(existing?: string | null): string {
  const base = (existing ?? "").trim();
  if (!base) return "M365 app registration (auto)";
  return /\(auto\)/i.test(base) ? base : `${base} (auto)`;
}

// The template field LABELS (from field-requirements.ts's m365-admin entry) mapped to the ProvisionResult
// value that fills them — undefined when this run issued nothing for that field, so it's never written.
function labeledValues(provision: ProvisionResult): Record<string, string | undefined> {
  return {
    "admin username / app id": provision.appId,
    "admin password / client secret": provision.clientSecret,
    "tenant id / domain": provision.tenantId,
    "certificate (base64 pfx)": provision.certBase64,
    "certificate password": provision.certPassword,
    "certificate thumbprint": provision.certThumbprint,
  };
}

// REQUIRED: the app cannot authenticate at all without these — a failure writing any of them fails the
// whole run. Everything else (the cert fields) is OPTIONAL/best-effort: a password-only Secret Server
// template legitimately has no certificate slug, and that must never fail an otherwise-good write —
// see Finding 5.
const REQUIRED_LABELS = new Set(["admin username / app id", "admin password / client secret", "tenant id / domain"]);

// Which Secret Server slugs (from this run's field map) are required vs. optional, so a per-field
// write result can be judged accordingly.
function slugBuckets(tmpl: { fieldMap: Record<string, string> }): { requiredSlugs: Set<string>; optionalSlugs: Set<string> } {
  const requiredSlugs = new Set<string>();
  const optionalSlugs = new Set<string>();
  for (const [label, slug] of Object.entries(tmpl.fieldMap)) {
    if (REQUIRED_LABELS.has(label)) requiredSlugs.add(slug);
    else optionalSlugs.add(slug);
  }
  return { requiredSlugs, optionalSlugs };
}

// Turn updateSecretFields' per-field results into a required-vs-optional verdict: any REQUIRED field
// failing fails the whole write; an OPTIONAL field failing is downgraded to a warning string.
function judgeFieldWrite(
  updated: { ok: boolean; results: { slug: string; ok: boolean; error?: string }[]; error?: string },
  buckets: { requiredSlugs: Set<string>; optionalSlugs: Set<string> }
): { ok: true; warnings: string[] } | { ok: false; error: string } {
  const requiredFails = updated.results.filter((r) => buckets.requiredSlugs.has(r.slug) && !r.ok);
  const optionalFails = updated.results.filter((r) => buckets.optionalSlugs.has(r.slug) && !r.ok);
  if (requiredFails.length > 0) {
    return { ok: false, error: requiredFails.map((r) => r.error).filter(Boolean).join("; ") || updated.error || "Delinea field update failed" };
  }
  const warnings = optionalFails.map(
    (r) => `optional field "${r.slug}" was not written (${r.error ?? "unknown error"}) — the template likely doesn't support it; the credential is still usable without it`
  );
  return { ok: true, warnings };
}

// A brand-new Entra app registration + client secret are not always immediately usable for a
// client-credentials grant — Entra can take ~30s-3min to propagate a new app registration across its
// directory replicas. During that window the SAME correct secret fails the probe with a propagation-
// class error. These are worth retrying; anything else (wrong secret, wrong tenant, wrong app kind) is
// a genuine, immediate failure and must not be retried or silently vaulted.
const PROPAGATION_ERROR_CODES = ["AADSTS700016", "AADSTS7000215"];
const PROPAGATION_ERRORS = new Set(["invalid_client", "unauthorized_client"]);

function isPropagationClassError(probe: EntraProbe): boolean {
  if (probe.ok) return false;
  const code = probe.errorCode ?? "";
  const err = probe.error ?? "";
  if (PROPAGATION_ERRORS.has(err)) return true;
  if (PROPAGATION_ERROR_CODES.some((c) => code.includes(c))) return true;
  // A network/timeout throw lands here with neither an errorCode nor a recognizable terminal `error` —
  // treat "we couldn't even get a verdict" the same as "propagation", since we can't tell it apart from
  // Entra being momentarily unreachable during the same window a brand-new app is still propagating.
  if (!code && !err) return true;
  return false;
}

const PROPAGATION_MAX_ATTEMPTS = 6; // ~6 attempts, ~15s apart => ~90s total retry window
const PROPAGATION_DELAY_MS = 15_000;
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const PROPAGATION_WARNING =
  "the new credential could not be verified against Entra yet (likely app-registration propagation delay) — it has been vaulted; re-run the client's connection test in a few minutes to confirm";

// Retry the live Entra probe past a propagation delay. Returns the final probe verdict plus a warning
// when we gave up on a propagation-class failure (never on a genuine/terminal failure — that's still a
// hard refusal, handled by the caller).
async function probeWithPropagationRetry(
  tenantId: string,
  appId: string,
  clientSecret: string,
  fetcher: typeof fetch,
  sleep: (ms: number) => Promise<void>
): Promise<{ probe: EntraProbe; propagationWarning?: string }> {
  let probe = await probeEntraClientCredentials(tenantId, appId, clientSecret, fetcher);
  let attempts = 1;
  while (!probe.ok && isPropagationClassError(probe) && attempts < PROPAGATION_MAX_ATTEMPTS) {
    await sleep(PROPAGATION_DELAY_MS);
    probe = await probeEntraClientCredentials(tenantId, appId, clientSecret, fetcher);
    attempts++;
  }
  if (probe.ok || !isPropagationClassError(probe)) return { probe };
  return { probe, propagationWarning: PROPAGATION_WARNING };
}

// How the vaulted secret's CERT field reads, by slug, from a raw Secret Server secret read:
//   "present"     — the cert slug exists and carries a non-empty value (vault is complete)
//   "empty"       — the cert slug exists on the template but holds nothing (half-vaulted credential)
//   "unsupported" — the template has no such slug (password-only template — Finding 5; not a gap)
//   "unknown"     — the read failed; can't tell (fail-safe: treat as complete, never churn creds)
type VaultCertState = "present" | "empty" | "unsupported" | "unknown";

async function readVaultCertState(
  cfg: { baseUrl: string; username: string; password: string },
  externalId: string,
  certSlug: string,
  token: string,
  fetcher: Fetcher
): Promise<VaultCertState> {
  try {
    const comment = encodeURIComponent("iam-engine automated provisioning");
    const res = await fetcher(`${cfg.baseUrl}/api/v1/secrets/${encodeURIComponent(externalId)}?autoComment=${comment}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return "unknown";
    const body = (await res.json().catch(() => null)) as { items?: Array<{ slug?: string; itemValue?: unknown }> } | null;
    if (!body?.items) return "unknown";
    const item = body.items.find((i) => (i.slug ?? "").toLowerCase() === certSlug.toLowerCase());
    if (!item) return "unsupported";
    return typeof item.itemValue === "string" && item.itemValue.trim() !== "" ? "present" : "empty";
  } catch {
    return "unknown";
  }
}

export async function writeProvisionedM365App(input: WriteInput, deps: WriteDeps): Promise<WriteResult> {
  const { client, provision } = input;
  const secretName = input.secretName ?? "m365-admin";
  const fetcher = deps.fetch;
  const env = deps.env ?? process.env;

  // 1. credState gate — decide trustworthiness BEFORE looking at whether a value string happens to be
  // present. Never infer from clientSecret/certBase64 alone (see CredState doc in provision-m365-app.ts).
  if (provision.credState === "unverified") {
    return {
      ok: false,
      wroteCreds: false,
      error: "could not verify the app registration's credentials (transient Graph error); not treating this as set up",
    };
  }

  // Finding 6: never repoint the client's vaulted secret at a newly-created app that isn't fully
  // provisioned yet — that would break a currently-working credential by pointing the vault row at a
  // half-provisioned app. Optional-cap gaps are fine; a REQUIRED gap or an unverified grant is not.
  if (provision.created && (!provision.verified || provision.gaps.length > 0)) {
    return {
      ok: false,
      wroteCreds: false,
      error: `app registration has unmet required Graph permissions (gaps: ${provision.gaps.join(", ") || "unverified"}); not vaulting/repointing`,
    };
  }

  if (provision.credState === "kept-valid") {
    // Genuinely nothing new to write UNLESS the vault has no row for this client at all — that's the
    // stranded case: the app reports a valid credential, but we hold none of it. The one-time secret
    // value from whenever it WAS issued is unrecoverable; the only fix is to rotate/re-issue.
    const existingRow = await deps.db.secret.findUnique({
      where: { clientId_name: { clientId: client.id, name: secretName } },
      select: { externalId: true, label: true },
    });
    // A "REPLACE_ME"/""/NOT_NEEDED placeholder is NOT a real vaulted id — ~106/137 clients carry one as
    // the seed default. Treat it as nothing-vaulted (stranded), so the recovery path re-issues and vaults
    // a REAL secret rather than reporting a fake "done" that surfaces the placeholder as the credential.
    if (!secretIsSet(existingRow?.externalId)) {
      return {
        ok: false,
        wroteCreds: false,
        stranded: true,
        error:
          "the app registration reports a valid credential but none is vaulted — it was likely issued on a prior run whose vault write failed; the app's credential must be rotated/re-issued manually (the prior one-time secret is unrecoverable)",
        hint: "re-run setup to force a credential rotation (the app registration's existing secret/cert cannot be re-read — only a fresh issue can be vaulted)",
      };
    }
    // A real id exists — but is what's vaulted COMPLETE? A prior run may have written the secret and
    // never the cert (56977: secret-only rotation, then every later run read "kept-valid" and no-op'd
    // forever, so the missing cert could never self-heal). Read the vault row's cert slug: if the
    // template supports it and it's EMPTY, the vaulted credential is half-written and its missing half
    // is unrecoverable → stranded, so the recovery path rotates BOTH and re-vaults complete material.
    // Any read failure (or no template/write config) degrades to the old "trust it" behaviour.
    const keptTmpl = templateFor(secretName, env);
    const certSlug = keptTmpl?.fieldMap["certificate (base64 pfx)"];
    // Only a cert-BEARING credential can be "half-vaulted" for a missing cert. When set up client-
    // secret-only (expectCert=false), an empty cert slug is intended, not stranded — skip the check.
    if (certSlug && input.expectCert !== false) {
      try {
        const keptCfg = delineaWriteConfigFromEnv(env);
        const keptFetcher: Fetcher = fetcher ?? (fetch as unknown as Fetcher);
        const keptToken = await getDelineaToken(keptCfg, keptFetcher);
        const certState = await readVaultCertState(keptCfg, existingRow!.externalId, certSlug, keptToken, keptFetcher);
        if (certState === "empty") {
          return {
            ok: false,
            wroteCreds: false,
            stranded: true,
            error:
              `the vaulted credential (Delinea ${existingRow!.externalId}) has no certificate material (${certSlug} is empty) — the cert's PFX/password from the original issue are unrecoverable, so the credential must be rotated to complete it`,
            hint: "recovery re-issues the secret + certificate together and re-vaults the complete credential",
          };
        }
      } catch {
        // best-effort — an unreadable vault must not fail a healthy kept-valid run
      }
    }
    // Nothing new to vault, but stamp the "(auto)" wiring label if it isn't already — so an
    // already-complete client set up by the auto flow still shows the marker (idempotent).
    const stamped = autoLabel(existingRow!.label);
    if (stamped !== (existingRow!.label ?? "")) {
      await makeClientRepository(deps.db).upsertSecrets(client.id, [{ name: secretName, externalId: existingRow!.externalId, label: stamped }]);
    }
    return { ok: true, wroteCreds: false, externalId: existingRow!.externalId };
  }

  // From here: provision.credState === "issued" — a new secret and/or cert was minted this run and
  // must be vaulted (it's the only copy). Proceed as before.

  // 2. Validate a newly issued client secret against Entra before vaulting it — refuse to write a
  // credential we just proved doesn't authenticate. A cert-only issue has no probe here (skip).
  // A propagation-class failure (brand-new app registration not yet replicated in Entra) is retried
  // with backoff; if it's STILL unverified after the retry window, vault the secret anyway with a
  // warning rather than stranding a secret we just minted via Graph this run — see PROPAGATION_WARNING.
  let propagationWarning: string | undefined;
  if (provision.clientSecret) {
    const sleep = deps.sleep ?? defaultSleep;
    const { probe, propagationWarning: warning } = await probeWithPropagationRetry(
      provision.tenantId,
      provision.appId,
      provision.clientSecret,
      (fetcher as unknown as typeof fetch) ?? fetch,
      sleep
    );
    if (!probe.ok && !warning) {
      return { ok: false, wroteCreds: false, error: probe.error ?? "the newly issued client secret failed a live test against Entra", hint: probe.hint };
    }
    propagationWarning = warning;
  }

  // 3. Gate: the app can only write when a write account + this client's folder + a template id for
  // this secret are all configured. Same check the manual create route uses.
  const cap = delineaWriteConfigured({ slug: client.slug, secretName, clientFolderId: client.delineaFolderId, env });
  if (!cap.ok) {
    return { ok: false, wroteCreds: false, error: `Delinea write not configured — ${cap.missing.join("; ")}` };
  }

  const folderId = folderIdFor(client.slug, client.delineaFolderId, env)!; // cap.ok guarantees non-null
  const tmpl = templateFor(secretName, env)!; // cap.ok guarantees a template
  const buckets = slugBuckets(tmpl);

  // 4. Map labels -> Secret Server slugs, skipping any label whose value is undefined this run.
  const fields: Record<string, string> = {};
  for (const [label, value] of Object.entries(labeledValues(provision))) {
    if (value === undefined) continue;
    const slug = tmpl.fieldMap[label];
    if (slug) fields[slug] = value;
  }

  const cfg = delineaWriteConfigFromEnv(env);
  let token: string;
  try {
    token = await getDelineaToken(cfg, fetcher);
  } catch (e) {
    return { ok: false, wroteCreds: false, error: `Delinea write auth failed — ${(e as Error).message}` };
  }

  // Does the client already have a Secret row for this name? If so, its externalId is the Delinea
  // secret we already vaulted — go straight at it. This is what makes the write robust to a naming
  // mismatch against createSecret's name-based dedup search (e.g. a secret created via the manual UI is
  // named `${client.name} — ${secretName}`, not `${client.slug} — ${secretName}`): searching by name
  // could miss it and createSecret would mint a SECOND, orphaned secret. Going by the known externalId
  // can't ever duplicate.
  const existingRow = await deps.db.secret.findUnique({
    where: { clientId_name: { clientId: client.id, name: secretName } },
    select: { externalId: true, label: true },
  });

  let externalId: string;
  let created: boolean;
  // Seed with the propagation warning (if any) — a field-write warning, if any, is appended below.
  let warnings: string[] = propagationWarning ? [propagationWarning] : [];
  // Only a REAL Delinea id counts as "already vaulted". A "REPLACE_ME"/""/NOT_NEEDED placeholder (the
  // seed default on ~106/137 clients) is NOT a secret to update in place — PUTting fields to secret id
  // "REPLACE_ME" 400s ("couldn't write it"). Fall through to CREATE, which mints a real secret and wires
  // its real id over the placeholder.
  if (secretIsSet(existingRow?.externalId)) {
    // 5a. Already vaulted — update the known secret in place. No name search, no create call, so this
    // can never mint a duplicate regardless of what the secret happens to be named in Secret Server.
    externalId = existingRow!.externalId;
    created = false;
    const updated = await updateSecretFields(cfg, externalId, fields, token, fetcher);
    const verdict = judgeFieldWrite(updated, buckets);
    if (!verdict.ok) {
      return { ok: false, wroteCreds: false, error: verdict.error };
    }
    warnings = warnings.concat(verdict.warnings);
  } else {
    // 5b. No local row — create it fresh. Name it the same way the manual create route does
    // (`${client.name} — ${secretName}`), plus an "(auto)" marker so it's clear in Delinea that this
    // credential was provisioned by the automated setup (not hand-entered).
    const ssName = `${client.name} — ${secretName} (auto)`;
    // Identity credentials belong in the client's "Identity Services" subfolder (correct team view
    // permissions), not the client ROOT — resolve it, falling back to the root if there's no such child.
    const subName = identitySubfolderName(env);
    const createFolderId = (subName && (await findChildFolderByName(cfg, folderId, subName, token, fetcher))) || folderId;
    const createdSecret = await createSecret(cfg, { name: ssName, folderId: createFolderId, templateId: tmpl.templateId, fields }, token, fetcher);
    if (!createdSecret.ok || !createdSecret.id) {
      return { ok: false, wroteCreds: false, error: createdSecret.error ?? "Delinea create failed" };
    }
    externalId = createdSecret.id;
    created = true;
    const updated = await updateSecretFields(cfg, externalId, fields, token, fetcher);
    const verdict = judgeFieldWrite(updated, buckets);
    if (!verdict.ok) {
      return { ok: false, wroteCreds: false, error: verdict.error };
    }
    warnings = warnings.concat(verdict.warnings);
  }

  // 6. Persist the vault REFERENCE (never a value): self-learn the folder if the client had none, then
  // wire the secret id onto the client the same way the manual create route does. The wiring LABEL is
  // stamped with "(auto)" so the client's Secrets panel shows this credential was set up by the auto
  // flow — preserving any existing label and only appending the marker once.
  if (folderId && !client.delineaFolderId) {
    await deps.db.client.update({ where: { id: client.id }, data: { delineaFolderId: folderId } });
  }
  await makeClientRepository(deps.db).upsertSecrets(client.id, [{ name: secretName, externalId, label: autoLabel(existingRow?.label) }]);

  return { ok: true, externalId, created, updated: !created, wroteCreds: true, warnings: warnings.length > 0 ? warnings : undefined };
}
