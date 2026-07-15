import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Single source of truth for config/secrets: the repo-root env.env. Next only auto-loads web/.env,
// so without this the app can't see env.env-only keys (DELINEA_*, REDIS_*, AZUREAI_*). Load it here
// (at config eval, before the server starts) into process.env WITHOUT overriding anything already
// set — so web/.env still wins for the few keys it owns (e.g. DATABASE_URL for the Prisma CLI).
function loadRootEnv() {
  const path = join(dirname(fileURLToPath(import.meta.url)), "..", "env.env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith("@")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    const k = t.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || process.env[k] !== undefined) continue;
    let v = t.slice(eq + 1).trim();
    if (v[0] === '"' || v[0] === "'") {
      const end = v.indexOf(v[0], 1);
      v = end > 0 ? v.slice(1, end) : v.slice(1);
    } else {
      const hash = v.search(/\s#/);
      if (hash >= 0) v = v.slice(0, hash).trim();
    }
    process.env[k] = v;
  }
}
loadRootEnv();

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Enable the server-startup hook (web/instrumentation.ts) — stable in Next 15, still flagged in
  // 14.2. It logs the runner bundle version the app serves to agents on every boot.
  experimental: { instrumentationHook: true },
};
export default nextConfig;
