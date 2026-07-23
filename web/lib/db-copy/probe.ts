// Staged connection probe for the db-copy tool. Instead of the one-shot checkConnection, this runs
// ordered steps (config → reachable → authenticated → database → version → tables) so the UI can show
// exactly WHAT it's connecting to and WHERE it fails — for both source and destination. The password
// is never emitted: every message is scrubbed, and identities use connLabel (host/user/db only).
import net from "node:net";
import { Client } from "pg";
import { sanitizeError } from "@/lib/jobs/db-backup";
import { type PgConn, connLabel } from "./config";
import { shortVersion } from "./plan";

export type ProbeStepName = "config" | "reachable" | "authenticated" | "database" | "version" | "tables";
export type ProbeStepStatus = "ok" | "fail" | "skipped";
export type ProbeStep = { step: ProbeStepName; label: string; status: ProbeStepStatus; detail?: string; ms?: number; error?: string };
export type ProbeResult = { ok: boolean; label: string; steps: ProbeStep[] };

const STEP_ORDER: ProbeStepName[] = ["config", "reachable", "authenticated", "database", "version", "tables"];
const STEP_LABEL: Record<ProbeStepName, string> = {
  config: "Config resolved",
  reachable: "Host reachable",
  authenticated: "Authenticated",
  database: "Database selected",
  version: "Server version",
  tables: "Tables counted",
};

// A minimal pg-client surface, so probeConnection can be driven by an injected fake in tests.
export type ProbeClient = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };
export type ProbeDeps = {
  tcpCheck: (host: string, port: number, timeoutMs: number) => Promise<number>;
  connect: (conn: PgConn) => Promise<ProbeClient>;
};

function errCode(e: unknown): string | undefined {
  return e && typeof e === "object" && "code" in e ? String((e as { code?: unknown }).code) : undefined;
}
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * A single `pg` connect() covers auth AND database-existence, so map its failure to the right step:
 * a missing catalog → "database"; bad credentials / pg_hba → "authenticated"; DNS + socket errnos →
 * "reachable"; anything else → "authenticated" (most post-TCP connect failures are auth/permission).
 * Pure and exhaustively unit-tested — the orchestrator clamps a "reachable" verdict to "authenticated"
 * once the TCP step has already passed.
 */
export function classifyConnectFailure(code: string | undefined, message: string): "reachable" | "authenticated" | "database" {
  const c = (code ?? "").toUpperCase();
  if (c === "3D000" || /does not exist/i.test(message)) return "database";
  if (c === "28P01" || c === "28000" || /authenticat|pg_hba|password/i.test(message)) return "authenticated";
  if (["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH"].includes(c)) return "reachable";
  return "authenticated";
}

// Default dependencies: a raw TCP reachability check (node:net) and a real pg client.
const realDeps: ProbeDeps = {
  tcpCheck: (host, port, timeoutMs) =>
    new Promise<number>((resolve, reject) => {
      const started = Date.now();
      const socket = net.connect({ host, port });
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeAllListeners();
        socket.destroy();
        fn();
      };
      const timer = setTimeout(
        () => finish(() => reject(Object.assign(new Error(`TCP connect timed out after ${timeoutMs}ms`), { code: "ETIMEDOUT" }))),
        timeoutMs,
      );
      socket.once("connect", () => finish(() => resolve(Date.now() - started)));
      socket.once("error", (e) => finish(() => reject(e)));
    }),
  connect: async (conn) => {
    const client = new Client({ host: conn.host, port: conn.port, user: conn.user, password: conn.password, database: conn.database });
    await client.connect();
    return client as unknown as ProbeClient;
  },
};

/** Run the staged probe. Never throws — a failure is reported as the failing step + skipped remainder. */
export async function probeConnection(conn: PgConn, deps: ProbeDeps = realDeps): Promise<ProbeResult> {
  const label = connLabel(conn);
  const scrub = (m: string) => {
    let s = sanitizeError(m);
    if (conn.password) s = s.split(conn.password).join("***"); // never leak the literal password
    return s;
  };
  const steps: ProbeStep[] = STEP_ORDER.map((step) => ({ step, label: STEP_LABEL[step], status: "skipped" as ProbeStepStatus }));
  const set = (name: ProbeStepName, patch: Partial<ProbeStep>) => Object.assign(steps.find((x) => x.step === name)!, patch);
  const done = (ok: boolean): ProbeResult => ({ ok, label, steps });

  set("config", { status: "ok", detail: `host=${conn.host} port=${conn.port} user=${conn.user} db=${conn.database} schema=${conn.schema}` });

  try {
    const ms = await deps.tcpCheck(conn.host, conn.port, 5000);
    set("reachable", { status: "ok", ms, detail: `TCP connect ${ms}ms` });
  } catch (e) {
    set("reachable", { status: "fail", error: scrub(errMsg(e)) });
    return done(false);
  }

  let client: ProbeClient;
  try {
    client = await deps.connect(conn);
    set("authenticated", { status: "ok", detail: `signed in as ${conn.user}` });
    set("database", { status: "ok", detail: `connected to ${conn.database}` });
  } catch (e) {
    let blamed = classifyConnectFailure(errCode(e), errMsg(e));
    if (blamed === "reachable") blamed = "authenticated"; // TCP already passed → pg-level handshake failure
    if (blamed === "database") set("authenticated", { status: "ok", detail: `signed in as ${conn.user}` });
    set(blamed, { status: "fail", error: scrub(errMsg(e)) });
    return done(false);
  }

  try {
    const v = await client.query("SELECT version() AS version");
    set("version", { status: "ok", detail: shortVersion(v.rows[0]?.version) });
    const t = await client.query(
      `SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
      [conn.schema],
    );
    set("tables", { status: "ok", detail: `${Number(t.rows[0]?.n ?? 0)} base tables in ${conn.schema}` });
  } catch (e) {
    const failStep: ProbeStepName = steps.find((x) => x.step === "version")!.status === "ok" ? "tables" : "version";
    set(failStep, { status: "fail", error: scrub(errMsg(e)) });
    await client.end().catch(() => {});
    return done(false);
  }
  await client.end().catch(() => {});
  return done(true);
}

/** Probe both databases in parallel (source + destination) for the side-by-side UI. */
export async function probeConnections(source: PgConn, dest: PgConn, deps?: ProbeDeps): Promise<{ source: ProbeResult; dest: ProbeResult }> {
  const [src, dst] = await Promise.all([probeConnection(source, deps), probeConnection(dest, deps)]);
  return { source: src, dest: dst };
}
