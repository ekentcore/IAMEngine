// One-off host remediation: after an OS/ICU upgrade, Postgres flags a "collation version
// mismatch" on template databases, which blocks CREATE DATABASE / Prisma's shadow DB.
// Refresh the recorded collation version so it matches the OS. Safe: updates bookkeeping
// only (does not alter actual string sort behavior of existing data).
import pg from "pg";
import { parseEnvFile, buildDatabaseUrl } from "./read-env.mjs";

const env = parseEnvFile();
const { dbName } = buildDatabaseUrl(env);

const client = new pg.Client({
  host: env.POSTGRES_HOST ?? "localhost",
  port: Number(env.POSTGRES_PORT ?? 5432),
  user: env.POSTGRES_USER,
  password: env.POSTGRES_PASSWORD,
  database: "postgres",
});

await client.connect();
for (const dbn of ["template1", "postgres", dbName]) {
  try {
    await client.query(`ALTER DATABASE "${dbn.replace(/"/g, '""')}" REFRESH COLLATION VERSION`);
    console.log(`Refreshed collation version on "${dbn}".`);
  } catch (err) {
    console.warn(`Skipped "${dbn}": ${err.message}`);
  }
}
await client.end();
