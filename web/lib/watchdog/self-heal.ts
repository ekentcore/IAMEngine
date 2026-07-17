// Self-healing watchdog for the web server. Born from the 2026-07-17 incident: a merge moved a file
// out from under a running `next dev`, one ModuleBuildError poisoned the whole dev module graph, and
// EVERY route — /api/agents/heartbeat included — returned 500 for ~20 minutes until a human
// restarted the server. The runner fleet stalls the moment that happens, so the server now watches
// itself: a loop started at boot (instrumentation, so it keeps running when routes break) probes the
// app's own /api/health/probe over loopback, and when the probe stays broken it announces, waits a
// grace period, and — only when a supervisor will relaunch it — exits.
//
// The one distinction everything hinges on:
//   "broken"  = the probe ROUTE never answered (5xx, or an answer without the probe marker, or the
//               loopback fetch itself failed). A restart rebuilds the module graph → restart-worthy.
//   "db-down" = the route RAN and reported the database unreachable. A restart cannot fix an
//               unreachable database — restarting here would loop the server forever. Never exit.
//
// Pure and dependency-injected so the whole state machine is unit-testable without timers.

export type ProbeClass = "ok" | "db-down" | "broken";

export function classifyProbe(status: number, body: unknown): ProbeClass {
  if (status >= 500) return "broken";
  const b = body as { probe?: unknown; db?: unknown } | null;
  if (!b || b.probe !== "iam") return "broken"; // something answered, but not our route
  return b.db === true ? "ok" : "db-down";
}

export type SelfHealState = "healthy" | "db-down" | "announced" | "exhausted";

export function createSelfHeal(deps: {
  probe: () => Promise<{ status: number; body: unknown } | null>; // null = the loopback fetch failed
  supervised: boolean;
  exit: () => void;
  log: (msg: string) => void;
  audit?: (action: string, detail: Record<string, unknown>) => Promise<void>;
  restartBudget: { take: () => boolean };
  failThreshold?: number;
  graceMs?: number;
}) {
  const threshold = deps.failThreshold ?? 3;
  const graceMs = deps.graceMs ?? 60_000;
  let brokenCount = 0;
  let dbDownCount = 0;
  let state: SelfHealState = "healthy";
  let deadline = 0;

  async function tick(nowMs: number): Promise<void> {
    let cls: ProbeClass;
    try {
      const res = await deps.probe();
      cls = res === null ? "broken" : classifyProbe(res.status, res.body);
    } catch {
      cls = "broken";
    }

    if (cls === "ok") {
      if (state !== "healthy") deps.log("[self-heal] probe recovered — restart cancelled");
      state = "healthy";
      brokenCount = 0;
      dbDownCount = 0;
      return;
    }

    if (cls === "db-down") {
      brokenCount = 0;
      dbDownCount++;
      state = "db-down";
      // Say it, but don't spam — and NEVER restart: the database being unreachable is not a fault a
      // relaunch can cure (see the Local Network / launchd lesson that proved exactly that).
      if (dbDownCount === threshold || dbDownCount % 15 === 0) {
        deps.log("[self-heal] the app is up but the DATABASE is unreachable — restarting would not help; check the DB host / network permission");
      }
      return;
    }

    // broken
    dbDownCount = 0;
    brokenCount++;
    if (state === "healthy" && brokenCount >= threshold) {
      state = "announced";
      deadline = nowMs + graceMs;
      const msg = deps.supervised
        ? `[self-heal] ${brokenCount} consecutive probe failures — the server will RESTART itself in ${Math.round(graceMs / 1000)}s unless it recovers (the supervisor relaunches it)`
        : `[self-heal] ${brokenCount} consecutive probe failures — every route is failing. No supervisor is active, so it will NOT self-restart: restart the dev server, or install the supervisor (web/scripts/activate-web-supervisor.sh) to make this automatic`;
      deps.log(msg);
      // Best-effort: the DB usually still works in this failure mode (routes break at the webpack
      // layer, not the data layer) — leave a trace an operator can find later.
      void deps.audit?.("server.selfheal.announced", { supervised: deps.supervised, graceMs }).catch(() => {});
      return;
    }
    if (state === "announced" && nowMs >= deadline) {
      if (!deps.supervised) return; // logged at announce time; without a supervisor an exit = outage
      if (!deps.restartBudget.take()) {
        state = "exhausted";
        deps.log("[self-heal] restart budget exhausted (too many self-restarts this hour) — the fault survives restarts; NOT exiting again. Investigate.");
        return;
      }
      deps.log("[self-heal] still broken after the grace period — exiting now; the supervisor relaunches the server");
      void deps.audit?.("server.selfheal.restart", { after: "grace" }).catch(() => {});
      deps.exit();
    }
  }

  return { tick, state: () => state };
}

// How many self-restarts are allowed per window. Persisted through the restart (that's the point) —
// the caller supplies read/write, in production a small JSON file in the OS temp dir.
export function createRestartBudget(deps: { read: () => string; write: (s: string) => void; max: number; windowMs: number; now: () => number }) {
  return {
    take(): boolean {
      let stamps: number[] = [];
      try { stamps = (JSON.parse(deps.read()) as number[]).filter((t) => typeof t === "number"); } catch { stamps = []; }
      const cutoff = deps.now() - deps.windowMs;
      stamps = stamps.filter((t) => t > cutoff);
      if (stamps.length >= deps.max) return false;
      stamps.push(deps.now());
      try { deps.write(JSON.stringify(stamps)); } catch { /* a failed write must not block recovery */ }
      return true;
    },
  };
}
