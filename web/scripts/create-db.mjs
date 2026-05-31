// Create the target Postgres database if it doesn't exist yet.
// Connects to the "postgres" maintenance DB with the same credentials and issues
// CREATE DATABASE. If the role lacks CREATEDB, prints a clear manual instruction.
import pg from "pg";
import { parseEnvFile, buildDatabaseUrl } from "./read-env.mjs";

const env = parseEnvFile();
const { dbName } = buildDatabaseUrl(env);

const client = new pg.Client({
  host: env.POSTGRES_HOST ?? "localhost",
  port: Number(env.POSTGRES_PORT ?? 5432),
  user: env.POSTGRES_USER,
  password: env.POSTGRES_PASSWORD,
  database: "postgres", // maintenance DB
});

try {
  await client.connect();
  const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
  if (rowCount > 0) {
    console.log(`Database "${dbName}" already exists — nothing to do.`);
  } else {
    // identifier can't be parameterized; dbName comes from our own env, quote defensively.
    // TEMPLATE template0 sidesteps a "collation version mismatch" on template1 that can
    // occur after an OS/ICU upgrade on the Postgres host.
    const ident = `"${dbName.replace(/"/g, '""')}"`;
    await client.query(`CREATE DATABASE ${ident} TEMPLATE template0`);
    console.log(`Created database "${dbName}".`);
  }
} catch (err) {
  console.error(`Could not create database "${dbName}": ${err.message}`);
  console.error(
    `Create it manually, e.g.:\n  psql -h ${env.POSTGRES_HOST} -U ${env.POSTGRES_USER} -d postgres -c 'CREATE DATABASE "${dbName}";'`
  );
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
