/* Snapshot every Secret.externalId + Client.delineaFolderId to a JSON + a rollback .sql, so the
 * credential-recovery apply pass (scripts/recover-delinea-creds.ts --apply) can be undone exactly.
 * Values are never touched — these are Delinea REFERENCES (ids), not credentials.
 *
 *   npx tsx scripts/snapshot-secret-refs.ts <out-dir>
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

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

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const db = new PrismaClient();

(async () => {
  const outDir = process.argv[2] ?? process.cwd();
  const secrets = await db.secret.findMany({ select: { id: true, clientId: true, name: true, externalId: true } });
  const clients = await db.client.findMany({ select: { id: true, slug: true, delineaFolderId: true } });

  writeFileSync(resolve(outDir, "rollback-pre-apply.json"), JSON.stringify({ takenAt: new Date().toISOString(), secrets, clients }, null, 1));
  const sql = [
    "-- Restores Secret.externalId + Client.delineaFolderId to their pre-recovery values.",
    ...secrets.map((s) => `UPDATE "Secret" SET "externalId"=${q(s.externalId)} WHERE id=${q(s.id)};`),
    ...clients.map((c) => `UPDATE "Client" SET "delineaFolderId"=${c.delineaFolderId === null ? "NULL" : q(c.delineaFolderId)} WHERE id=${q(c.id)};`),
  ].join("\n");
  writeFileSync(resolve(outDir, "rollback-pre-apply.sql"), sql + "\n");

  console.log(`snapshot: ${secrets.length} secrets, ${clients.length} clients -> ${outDir}/rollback-pre-apply.{json,sql}`);
  await db.$disconnect();
})();
