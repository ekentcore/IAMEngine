import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resolveAzureBackup, azureConfigured, blobPath, blobUrlOf, redactAzureSecrets, sha256File,
  MANAGED_IDENTITY, AZURE_DEFAULTS,
} from "./backup-blob";

test("resolveAzureBackup: DARK by default — a missing/blank setting is disabled", () => {
  const c = resolveAzureBackup(null);
  assert.equal(c.enabled, false); // ship dark (D1): nothing calls Azure until switched on
  assert.equal(c.credentialRef, MANAGED_IDENTITY); // strongest default — no stored secret
  assert.equal(c.retentionDays, AZURE_DEFAULTS.retentionDays);
  assert.equal(resolveAzureBackup(undefined).enabled, false);
  assert.equal(resolveAzureBackup({} as never).enabled, false);
});

test("azureConfigured: enabled alone is not enough — needs account AND container", () => {
  assert.equal(azureConfigured(resolveAzureBackup({ enabled: true })), false);
  assert.equal(azureConfigured(resolveAzureBackup({ enabled: true, account: "acct" })), false);
  assert.equal(azureConfigured(resolveAzureBackup({ enabled: true, account: "acct", container: "c" })), true);
  // enabled false with everything else set is still off
  assert.equal(azureConfigured(resolveAzureBackup({ account: "acct", container: "c" })), false);
});

test("blobPath / blobUrlOf: deterministic, unique-per-dump, mirrors the local name", () => {
  assert.equal(blobPath("iam", "20260722-020000"), "iam-engine/iam/iam-20260722-020000.dump");
  const cfg = resolveAzureBackup({ enabled: true, account: "acct", container: "backups" });
  assert.equal(blobUrlOf(cfg, "iam-engine/iam/iam-x.dump"), "https://acct.blob.core.windows.net/backups/iam-engine/iam/iam-x.dump");
});

test("redactAzureSecrets: scrubs SAS sig/se, AccountKey, connection strings — the mandatory extension", () => {
  const sas = "https://a.blob.core.windows.net/c/b.dump?sv=2023-01-01&se=2026-07-30T00%3A00%3A00Z&sig=AbCdEf123SECRET%2Bxyz";
  const r = redactAzureSecrets(sas);
  assert.ok(!r.includes("AbCdEf123SECRET"), "SAS signature must be scrubbed");
  assert.ok(!r.includes("2026-07-30"), "SAS expiry (se=) must be scrubbed");
  assert.match(r, /sig=\*\*\*/);
  assert.match(r, /se=\*\*\*/);

  const conn = "DefaultEndpointsProtocol=https;AccountName=a;AccountKey=SUPERSECRETKEY==;EndpointSuffix=core.windows.net";
  const r2 = redactAzureSecrets(conn);
  assert.ok(!r2.includes("SUPERSECRETKEY"), "account key must be scrubbed");
  assert.match(r2, /AccountKey=\*\*\*/);

  const env = "spawn failed: AZURE_STORAGE_CONNECTION_STRING=BlobEndpoint=https://x;SharedAccessSignature=sv=1&sig=leak";
  const r3 = redactAzureSecrets(env);
  assert.ok(!r3.includes("sig=leak"));
  assert.ok(!r3.includes("BlobEndpoint=https://x"));

  // a bare SAS token not preceded by ? or & is still scrubbed
  assert.match(redactAzureSecrets("sig=rawtoken"), /sig=\*\*\*/);
  // benign text is left alone
  assert.equal(redactAzureSecrets("upload succeeded"), "upload succeeded");
});

test("sha256File: stable, content-addressed checksum for end-to-end integrity", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "blobtest-"));
  try {
    const f = path.join(dir, "d.dump");
    await writeFile(f, "hello-dump");
    const h1 = await sha256File(f);
    const h2 = await sha256File(f);
    assert.equal(h1, h2); // deterministic
    assert.match(h1, /^[0-9a-f]{64}$/); // sha-256 hex
    await writeFile(f, "hello-dump!"); // one byte different
    assert.notEqual(await sha256File(f), h1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
