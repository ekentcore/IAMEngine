// Connection/credential health checks for the app's integrations. Each check reports whether the
// integration is CONFIGURED (env present) and whether it's REACHABLE with those creds (a real,
// cheap round-trip). Used by GET /api/health and the /health page. Reuses each integration's own
// config helper so "configured" matches what the feature actually reads.
//
// Env note: the Next app only auto-loads web/.env. Delinea/Redis (and the AZUREAI_* aliases) live
// in the repo-root env.env, so we load that here too (without overriding anything already set) —
// otherwise those checks would report "not configured" even though you set them.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import net from "node:net";
import { db } from "@/lib/db";
import { delineaConfigFromEnv, delineaConfigured, getDelineaToken } from "@/lib/secrets/delinea";
import { azureConfigFromEnv, azureConfigured, azureChatJson } from "@/lib/generator/llm";
import { snConfigFromEnv } from "@/lib/servicenow/gateway";
import { snGet } from "@/lib/servicenow/http";

export type HealthStatus = "ok" | "fail" | "not_configured";
export type HealthResult = { name: string; status: HealthStatus; detail: string; latencyMs: number | null };

// Re-read env.env on EVERY health run (no caching) and override process.env for the keys it
// defines, so editing a credential in env.env and clicking "Re-run checks" reflects the change
// without restarting the server. env.env only holds app config (no Next internals), so syncing
// process.env to it is safe. web/.env still provides keys absent from env.env (e.g. DATABASE_URL).
function loadRootEnv(): void {
  const path = join(process.cwd(), "..", "env.env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith("@")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    const k = t.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    let v = t.slice(eq + 1).trim();
    // Quoted: take the quoted span and ignore any trailing inline comment. Unquoted: strip a
    // ` #…` inline comment. Without this, a value like `url"   # note` leaks the comment into env.
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

const ms = (start: number) => Date.now() - start;
const ok = (name: string, detail: string, start: number): HealthResult => ({ name, status: "ok", detail, latencyMs: ms(start) });
const fail = (name: string, detail: string, start: number): HealthResult => ({ name, status: "fail", detail, latencyMs: ms(start) });
const unconfigured = (name: string, detail: string): HealthResult => ({ name, status: "not_configured", detail, latencyMs: null });

// ---- Postgres (Prisma) ---------------------------------------------------
async function checkPostgres(): Promise<HealthResult> {
  const name = "PostgreSQL";
  if (!process.env.DATABASE_URL) return unconfigured(name, "DATABASE_URL not set");
  const start = Date.now();
  try {
    await db.$queryRaw`SELECT 1`;
    const clients = await db.client.count();
    return ok(name, `SELECT 1 ok · ${clients} clients`, start);
  } catch (e) {
    return fail(name, (e as Error).message, start);
  }
}

// ---- Redis (raw RESP PING, no driver dependency) -------------------------
async function checkRedis(): Promise<HealthResult> {
  const name = "Redis";
  const host = process.env.REDIS_HOST;
  const port = Number(process.env.REDIS_PORT ?? 6379);
  const pass = process.env.REDIS_PASSWORD;
  if (!host) return unconfigured(name, "REDIS_HOST not set");
  const start = Date.now();
  return new Promise<HealthResult>((resolve) => {
    let settled = false;
    const sock = net.connect({ host, port });
    let buf = "";
    const finish = (r: HealthResult) => { if (settled) return; settled = true; try { sock.destroy(); } catch { /* ignore */ } resolve(r); };
    sock.setTimeout(2500);
    sock.on("connect", () => {
      const cmds: string[] = [];
      if (pass) cmds.push(`*2\r\n$4\r\nAUTH\r\n$${Buffer.byteLength(pass)}\r\n${pass}\r\n`);
      cmds.push("*1\r\n$4\r\nPING\r\n");
      sock.write(cmds.join(""));
    });
    sock.on("data", (d) => {
      buf += d.toString();
      if (/-(?:WRONGPASS|NOAUTH|ERR|DENIED)/i.test(buf)) finish(fail(name, buf.split("\r\n")[0].replace(/^-/, ""), start));
      else if (buf.includes("+PONG")) finish(ok(name, `PONG · ${host}:${port}`, start));
    });
    sock.on("error", (e) => finish(fail(name, e.message, start)));
    sock.on("timeout", () => finish(fail(name, "connection timed out", start)));
  });
}

// ---- Delinea (OAuth2 password grant — proves base URL + service account) --
async function checkDelinea(): Promise<HealthResult> {
  const name = "Delinea";
  const cfg = delineaConfigFromEnv();
  if (!delineaConfigured(cfg)) return unconfigured(name, "set DELINEA_BASE_URL / DELINEA_USER / DELINEA_PASSWORD");
  const start = Date.now();
  try {
    await getDelineaToken(cfg);
    return ok(name, `authenticated · ${cfg.baseUrl}`, start);
  } catch (e) {
    return fail(name, (e as Error).message, start);
  }
}

// ---- ServiceNow (cheap authenticated read) -------------------------------
async function checkServiceNow(): Promise<HealthResult> {
  const name = "ServiceNow";
  const cfg = snConfigFromEnv();
  if (!cfg.instanceUrl || !cfg.username || !cfg.password) return unconfigured(name, "set SN_INSTANCE_URL / SN_USER / SN_PASSWORD");
  const start = Date.now();
  try {
    await snGet(cfg, "/api/now/table/sys_user", { sysparm_limit: "1", sysparm_fields: "sys_id" });
    return ok(name, cfg.instanceUrl, start);
  } catch (e) {
    return fail(name, (e as Error).message, start);
  }
}

// ---- Azure OpenAI (tiny JSON-mode round trip) ----------------------------
async function checkAzureAi(): Promise<HealthResult> {
  const name = "Azure OpenAI";
  const cfg = azureConfigFromEnv();
  if (!azureConfigured(cfg)) return unconfigured(name, "set AZUREAI_BASE / AZUREAI_API (or AZURE_OPENAI_*)");
  const start = Date.now();
  const res = await azureChatJson(cfg, "You reply only with JSON.", 'Return {"ok":true}', 20);
  return res ? ok(name, `deployment ${cfg.deployment}`, start)
             : fail(name, "no response (auth/endpoint/deployment — check AZUREAI_* values)", start);
}

// Registry — add a check here and it shows up on the page automatically.
const CHECKS: Array<() => Promise<HealthResult>> = [checkPostgres, checkRedis, checkDelinea, checkServiceNow, checkAzureAi];

export async function runHealthChecks(): Promise<HealthResult[]> {
  loadRootEnv();
  return Promise.all(CHECKS.map((c) => c().catch((e) => fail("unknown", (e as Error).message, Date.now()))));
}
