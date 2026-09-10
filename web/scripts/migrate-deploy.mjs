// Apply pending Prisma migrations to the configured database.
//
// Why this exists rather than "just run npx prisma migrate deploy": Prisma reads DATABASE_URL from
// web/.env, and web/.env is a GENERATED file that is not in the repo — on a fresh checkout it simply
// is not there, and `prisma migrate deploy` then fails with no datasource. The credentials live in
// the repo-root env file (POSTGRES_*), the same single source of truth every script here uses, so
// this assembles the URL with the shared buildDatabaseUrl() and hands it to prisma through the child
// process environment. The password never reaches the command line (and so never reaches shell
// history or `ps`), which is the other reason not to paste a connection string by hand.
//
// This step is not optional and not deferrable: shipping app code that reads a column before the
// column exists takes the whole app down, not just the new feature — every page that touches the
// changed model starts throwing. Run this BEFORE deploying code that needs it.
//
//   node scripts/migrate-deploy.mjs           apply pending migrations
//   node scripts/migrate-deploy.mjs status    show what is pending, change nothing
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnvFile, buildDatabaseUrl } from "./read-env.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");

// The root env file has been called both things across checkouts; accept either rather than failing
// with a path nobody can act on.
function envPath() {
  for (const name of ["env.env", ".env"]) {
    const p = resolve(ROOT, name);
    if (existsSync(p)) return p;
  }
  console.error(`no env file at ${ROOT}\env.env or ${ROOT}\.env — cannot resolve the database`);
  process.exit(1);
}

const env = parseEnvFile(envPath());
if (!env.POSTGRES_HOST || !env.POSTGRES_USER) {
  console.error("the env file has no POSTGRES_HOST/POSTGRES_USER — cannot reach the database");
  process.exit(1);
}
const { url, dbName } = buildDatabaseUrl(env);
const action = process.argv[2] === "status" ? "status" : "deploy";
console.log(`${action}: ${env.POSTGRES_HOST}/${dbName}`);

const r = spawnSync("npx", ["prisma", "migrate", action], {
  cwd: resolve(HERE, ".."),
  env: { ...process.env, DATABASE_URL: url },
  stdio: "inherit",
  shell: process.platform === "win32", // npx is a .cmd on Windows
});
process.exit(r.status ?? 1);
