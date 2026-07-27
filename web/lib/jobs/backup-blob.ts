// Feature #5, Phase 2 — off-box durable copy of each verified dump in Azure Blob Storage.
//
// SHIPS DARK (D1): every function here no-ops unless `backup.azure.enabled` is true AND an account +
// container are configured. Nothing in this module reaches the network until an operator flips the
// switch at/after the Azure cutover — pre-migration the local pg_dump machinery is untouched.
//
// Mechanism (design §3.1): shell out to the `az storage blob upload` CLI via execFile, matching the
// existing execFile(pg_dump…) pattern, rather than adding the @azure/* SDKs. Auth (design §3.2, D2):
//   - preferred: system-assigned MANAGED IDENTITY — credentialRef === "managed-identity" ⇒ pass
//     `--auth-mode login`, no stored secret at all.
//   - fallback: a Delinea-brokered SAS / connection string — credentialRef is a Delinea EXTERNAL ID
//     (never a value); the app brokers a short-lived connection string at run time, injects it into the
//     az process env (AZURE_STORAGE_CONNECTION_STRING), and never persists it.
// The credential is ALWAYS a reference. No account key or SAS string is ever written to AppSetting,
// a profile, a dump, or code. Any az/error text is scrubbed by redactAzureSecrets before it is logged.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { PrismaClient } from "@prisma/client";
import { getAppSetting } from "../settings";
import { delineaConfigFromEnv, delineaConfigured, resolveSecretFields } from "../secrets/delinea";

const execFileP = promisify(execFile);

// S3: the Azure backup config object. Its own AppSetting key; the drill keeps a SEPARATE key so each
// sweep can claim its own row race-safely (see restore-drill.ts).
export const AZURE_BACKUP_KEY = "backup.azure";

// Sentinel credentialRef meaning "use the VM's managed identity (`--auth-mode login`), no secret".
export const MANAGED_IDENTITY = "managed-identity";

// Raw (possibly partial / legacy / unparseable) AppSetting shape.
export type AzureBackupSetting = {
  enabled?: boolean;
  account?: string;       // storage account name (NOT a secret)
  container?: string;     // container name
  credentialRef?: string; // "managed-identity" OR a Delinea external id — NEVER a credential value
  retentionDays?: number; // enforced by an Azure lifecycle policy, not by the app deleting blobs
  localKeepDays?: number; // optional shorter local window once Blob is authoritative
};

// The resolved, always-complete config the runtime consumes.
export type AzureBackupConfig = {
  enabled: boolean;
  account: string;
  container: string;
  credentialRef: string;
  retentionDays: number;
  localKeepDays: number | null;
};

export const AZURE_DEFAULTS = {
  retentionDays: 90, // longer than the local window — Blob is durable/cheap
} as const;

// Fail-safe resolver: a missing / non-object / unparseable setting reads as DISABLED, so the whole
// feature is inert until switched on. credentialRef defaults to the managed-identity sentinel (the
// strongest option, no stored secret) rather than to anything that could imply a hardcoded value.
export function resolveAzureBackup(raw: AzureBackupSetting | null | undefined): AzureBackupConfig {
  const r = raw && typeof raw === "object" ? raw : {};
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : d);
  return {
    enabled: r.enabled === true,
    account: typeof r.account === "string" ? r.account.trim() : "",
    container: typeof r.container === "string" ? r.container.trim() : "",
    credentialRef: typeof r.credentialRef === "string" && r.credentialRef.trim() ? r.credentialRef.trim() : MANAGED_IDENTITY,
    retentionDays: num(r.retentionDays, AZURE_DEFAULTS.retentionDays),
    localKeepDays: typeof r.localKeepDays === "number" && r.localKeepDays >= 1 ? Math.floor(r.localKeepDays) : null,
  };
}

// The one gate everything checks: upload/download are attempted ONLY when enabled AND fully addressed.
// A half-configured setting (enabled but no account/container) is treated as off, never as "try and
// fail on every backup".
export function azureConfigured(cfg: AzureBackupConfig): boolean {
  return cfg.enabled && cfg.account.length > 0 && cfg.container.length > 0;
}

// Deterministic, unique-per-dump blob name (design §3.1/§3.3). Mirrors the local ${dbName}-${stamp}.dump
// naming so a name collision is a bug worth failing on, never a silent overwrite.
export function blobPath(dbName: string, stamp: string): string {
  return `iam-engine/${dbName}/${dbName}-${stamp}.dump`;
}

export function blobUrlOf(cfg: AzureBackupConfig, path: string): string {
  return `https://${cfg.account}.blob.core.windows.net/${cfg.container}/${path}`;
}

// Redact SAS tokens (sig=/se=), account keys, and full connection strings from any az/error output —
// an `az` failure message can echo the connection string, and the SAS/key is the actual secret. Scrubs
// at a string boundary so it also catches a bare token (sv=…&sig=…) not preceded by ? or &.
export function redactAzureSecrets(msg: string): string {
  return msg
    .replace(/(^|[?&;])sig=[^&;\s"']*/gi, "$1sig=***")
    .replace(/(^|[?&;])se=[^&;\s"']*/gi, "$1se=***")
    .replace(/AccountKey=[^;\s"']*/gi, "AccountKey=***")
    .replace(/SharedAccessSignature=[^;\s"']*/gi, "SharedAccessSignature=***")
    .replace(/AZURE_STORAGE_CONNECTION_STRING=\S*/gi, "AZURE_STORAGE_CONNECTION_STRING=***");
}

// SHA-256 of a file, streamed so a multi-GB dump never lands in memory. Used end-to-end: recorded on
// upload and re-verified after a blob download in the drill (design §3.3).
export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

// Locate the `az` CLI. On the Azure VM it is on PATH; allow an explicit override for odd installs.
export function findAzBin(): string {
  return process.env.AZ_BIN || "az";
}

// --- managed-identity login --------------------------------------------------------------------------
// `--auth-mode login` REUSES the CLI's existing session; it does not log in by itself, and a fresh
// container has none — every upload would die with "Please run 'az login'". On Azure Container Apps
// the identity endpoint is available in-process, so a one-time `az login --identity` binds the CLI to
// the app's system-assigned identity with no secret involved. Cached per process (the heartbeat sweeps
// must not fork a login per upload); a dev box with a human `az login` passes the account-show probe
// and is left alone. `--allow-no-subscriptions` because the app's identity carries only the data-plane
// role (Storage Blob Data Contributor on the backup account), never a subscription-level one.
type ExecLike = (file: string, args: string[], opts: { timeout: number }) => Promise<unknown>;
let azIdentityLoginOk = false;
export function resetAzIdentityLogin(): void { azIdentityLoginOk = false; } // test seam
export async function ensureAzIdentityLogin(exec: ExecLike = execFileP): Promise<void> {
  if (azIdentityLoginOk) return;
  const az = findAzBin();
  try {
    await exec(az, ["account", "show", "-o", "none"], { timeout: 30_000 });
  } catch {
    await exec(az, ["login", "--identity", "--allow-no-subscriptions", "-o", "none"], { timeout: 120_000 });
  }
  azIdentityLoginOk = true;
}

// Resolve the CLI auth flags + env for a given credentialRef. Managed identity ⇒ `--auth-mode login`,
// no env secret. Otherwise the ref is a Delinea external id: broker a short-lived connection string
// and hand it to az via AZURE_STORAGE_CONNECTION_STRING (never persisted, never logged un-redacted).
// The brokered value is looked up under one of a few conventional field names on the Delinea secret.
export async function resolveAzureAuth(
  cfg: AzureBackupConfig,
): Promise<{ args: string[]; env: Record<string, string> }> {
  if (cfg.credentialRef === MANAGED_IDENTITY) {
    await ensureAzIdentityLogin();
    return { args: ["--auth-mode", "login"], env: {} };
  }
  const dc = delineaConfigFromEnv();
  if (!delineaConfigured(dc)) {
    throw new Error("backup.azure.credentialRef is a Delinea id but Delinea is not configured on the app");
  }
  const res = await resolveSecretFields(dc, cfg.credentialRef);
  if (!res.ok) throw new Error(`could not broker Azure Storage credential from Delinea: ${res.error}`);
  const f = res.fields ?? {};
  const connStr =
    f["connection-string"] || f["connectionString"] || f["AZURE_STORAGE_CONNECTION_STRING"] || f["sas"] || f["password"] || "";
  if (!connStr) throw new Error("brokered Delinea secret has no connection-string / sas field");
  return { args: [], env: { AZURE_STORAGE_CONNECTION_STRING: connStr } };
}

// Read + resolve the Azure config in one call (the sweep and the backup path use this).
export async function loadAzureBackup(db: PrismaClient): Promise<AzureBackupConfig> {
  return resolveAzureBackup(await getAppSetting<AzureBackupSetting>(db, AZURE_BACKUP_KEY));
}

export type BlobUploadResult = { blobUrl: string; blobPath: string; checksum: string; uploadedAt: string };

// Upload one verified dump to Blob. Assumes azureConfigured(cfg) === true (the caller gates). Computes
// the checksum locally, passes it as Content-MD5-equivalent integrity via --validate-content so a
// corrupted transfer is caught by the service, and records the SHA-256 for the drill to re-verify.
// Never overwrites: --overwrite is NOT passed, so a name collision fails loudly (design §3.1).
export async function uploadDumpToBlob(
  cfg: AzureBackupConfig,
  localDumpPath: string,
  dbName: string,
  stamp: string,
): Promise<BlobUploadResult> {
  const path = blobPath(dbName, stamp);
  const checksum = await sha256File(localDumpPath);
  const auth = await resolveAzureAuth(cfg);
  const az = findAzBin();
  const args = [
    "storage", "blob", "upload",
    "--account-name", cfg.account,
    "--container-name", cfg.container,
    "--name", path,
    "--file", localDumpPath,
    "--validate-content",
    ...auth.args,
  ];
  await execFileP(az, args, { timeout: 30 * 60_000, env: { ...process.env, ...auth.env } });
  return { blobUrl: blobUrlOf(cfg, path), blobPath: path, checksum, uploadedAt: new Date().toISOString() };
}

// Download the most recent dump blob for a db to a local path (the drill's off-box test). Lists the
// prefix, picks the lexicographically-last name (timestamped ⇒ newest), downloads it. Returns the
// local path + the blob name so the caller can re-verify the checksum.
export async function downloadLatestBlob(
  cfg: AzureBackupConfig,
  dbName: string,
  destPath: string,
): Promise<{ localPath: string; blobPath: string }> {
  const auth = await resolveAzureAuth(cfg);
  const az = findAzBin();
  const prefix = `iam-engine/${dbName}/`;
  const list = await execFileP(
    az,
    ["storage", "blob", "list", "--account-name", cfg.account, "--container-name", cfg.container,
      "--prefix", prefix, "--query", "[].name", "-o", "tsv", ...auth.args],
    { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...auth.env } },
  );
  const names = list.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).sort();
  const latest = names[names.length - 1];
  if (!latest) throw new Error(`no dump blobs under ${prefix}`);
  await execFileP(
    az,
    ["storage", "blob", "download", "--account-name", cfg.account, "--container-name", cfg.container,
      "--name", latest, "--file", destPath, ...auth.args],
    { timeout: 30 * 60_000, env: { ...process.env, ...auth.env } },
  );
  return { localPath: destPath, blobPath: latest };
}
