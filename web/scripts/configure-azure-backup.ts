/* Configure the off-box Azure Blob backup copy (the `backup.azure` AppSetting).
 *
 *   npx tsx scripts/configure-azure-backup.ts                                        # show current
 *   npx tsx scripts/configure-azure-backup.ts --account acct --container db-backups --enable
 *   npx tsx scripts/configure-azure-backup.ts --disable                              # switch off
 *   npx tsx scripts/configure-azure-backup.ts --retention 90                         # blob lifecycle window (days)
 *
 * The credential is ALWAYS a reference (default: managed-identity — no secret anywhere). This script
 * refuses anything that looks like a raw SAS/key/connection string: secrets never land in AppSetting.
 * Retention is enforced by an Azure lifecycle policy on the storage account, not by the app; the
 * value here is recorded so operators can see what was intended.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { AZURE_BACKUP_KEY, resolveAzureBackup, MANAGED_IDENTITY, type AzureBackupSetting } from "../lib/jobs/backup-blob";
import { getAppSetting, setAppSetting } from "../lib/settings";

function loadEnvFiles(): void {
  for (const p of [resolve(__dirname, "..", ".env"), resolve(__dirname, "..", "..", ".env")]) {
    let text: string;
    try { text = readFileSync(p, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || line.trim().startsWith("#")) continue;
      if (process.env[m[1]] !== undefined) continue;
      let v = m[2];
      const dq = v.match(/^"([^"]*)"/);
      if (dq) v = dq[1]; else v = v.replace(/\s+#.*$/, "");
      process.env[m[1]] = v.trim();
    }
  }
}
loadEnvFiles();

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

// A credentialRef must be the managed-identity sentinel or a Delinea external id — never a value.
// Catch the obvious mistakes loudly instead of persisting a secret.
function looksLikeSecret(v: string): boolean {
  return /sig=|AccountKey=|SharedAccessSignature=|DefaultEndpointsProtocol=/i.test(v);
}

const db = new PrismaClient();

async function main(): Promise<void> {
  const raw = ((await getAppSetting<AzureBackupSetting>(db, AZURE_BACKUP_KEY)) ?? {}) as AzureBackupSetting;
  const next: AzureBackupSetting = { ...raw };

  let changed = false;
  const account = flag("--account");
  const container = flag("--container");
  const credentialRef = flag("--credential-ref");
  const retention = flag("--retention");
  if (account !== undefined) { next.account = account; changed = true; }
  if (container !== undefined) { next.container = container; changed = true; }
  if (credentialRef !== undefined) {
    if (looksLikeSecret(credentialRef)) throw new Error("credentialRef looks like a raw credential — pass 'managed-identity' or a Delinea external id, never a SAS/key");
    next.credentialRef = credentialRef; changed = true;
  }
  if (retention !== undefined) { next.retentionDays = Number(retention); changed = true; }
  if (argv.includes("--enable")) { next.enabled = true; changed = true; }
  if (argv.includes("--disable")) { next.enabled = false; changed = true; }

  if (changed) {
    if (!next.credentialRef) next.credentialRef = MANAGED_IDENTITY;
    await setAppSetting(db, AZURE_BACKUP_KEY, next);
    await db.auditLog.create({
      data: {
        actor: "script:configure-azure-backup",
        action: "settings.azurebackup.update",
        detail: { ...resolveAzureBackup(next) },
      },
    }).catch((e: unknown) => console.error(`(audit row failed: ${e instanceof Error ? e.message : String(e)})`));
  }

  const resolved = resolveAzureBackup(next);
  console.log(JSON.stringify(resolved, null, 2));
  console.error(changed ? "\nSaved." : "\nNo flags given — nothing changed. Flags: --account --container --credential-ref --retention --enable --disable");
  if (resolved.enabled && (!resolved.account || !resolved.container)) {
    console.error("WARNING: enabled but not fully addressed (account+container) — the feature stays inert until both are set.");
  }
}

main().finally(() => db.$disconnect());
