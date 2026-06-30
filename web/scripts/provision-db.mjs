// Idempotent, NON-DESTRUCTIVE database provisioner — safe to run against a fresh OR an existing DB.
// Builds everything that's missing and NEVER drops/overwrites your data (client config, KBs, cases…):
//   1. CREATE DATABASE if absent (TEMPLATE template0 — avoids collation-version mismatch). Best-effort:
//      on a managed host where the role can't CREATE DATABASE (e.g. Azure Flexible), create it in the
//      portal first; this step warns and continues.
//   2. prisma migrate deploy — applies only the migrations not yet applied. Additive: it adds missing
//      tables/columns, it does NOT drop or rewrite existing ones.
//   3. Seed ONLY when the DB is empty (0 clients). If data already exists (a fresh restore, or a DB
//      you've been using), seeding is SKIPPED so it can't clobber hand-made config / KB profiles.
//
// Targets DATABASE_URL if set (use the full Azure URL incl. ?sslmode=require), else builds it from the
// POSTGRES_* vars in ../env.env. Usage:  node scripts/provision-db.mjs
import { execSync } from "node:child_process";
import pg from "pg";
import { parseEnvFile, buildDatabaseUrl } from "./read-env.mjs";

const env = parseEnvFile();
const dbUrl = process.env.DATABASE_URL || buildDatabaseUrl(env).url;
const needsSsl = /sslmode=require/i.test(dbUrl) || /\.postgres\.database\.azure\.com/i.test(dbUrl);
const childEnv = { ...process.env, DATABASE_URL: dbUrl };

const run = (cmd) => execSync(cmd, { cwd: process.cwd(), env: childEnv, stdio: "inherit" });

console.log(`\n→ provisioning ${dbUrl.replace(/:[^:@/]+@/, ":****@")}\n`);

// 1. Create the database if it doesn't exist (best-effort — may be pre-created on a managed host).
console.log("1/3 ensure database exists");
try { run("node scripts/create-db.mjs"); }
catch { console.warn("   (create-db skipped/failed — assuming the database already exists; continuing)"); }

// 2. Build/upgrade the schema — additive only, never destructive.
console.log("\n2/3 prisma migrate deploy (additive — never drops data)");
run("npx prisma migrate deploy");

// 3. Seed ONLY when empty, so existing setup/KBs are never overwritten.
console.log("\n3/3 seed only if empty (preserve any existing data)");
const client = new pg.Client({ connectionString: dbUrl, ssl: needsSsl ? { rejectUnauthorized: false } : undefined });
let clientCount = null;
try {
  await client.connect();
  const r = await client.query('SELECT COUNT(*)::int AS n FROM "Client"');
  clientCount = r.rows[0].n;
} catch (e) {
  console.warn(`   couldn't read the Client table (${e.message}) — skipping seed to be safe.`);
} finally {
  await client.end().catch(() => {});
}

if (clientCount === 0) {
  console.log("   database is empty → seeding initial data");
  run("npx prisma db seed");
} else if (clientCount === null) {
  console.log("   skipped seed (couldn't confirm the DB is empty).");
} else {
  console.log(`   ${clientCount} clients already present → SKIPPING seed (your data is preserved).`);
}

console.log("\n✓ provision complete.\n");
