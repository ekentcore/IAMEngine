// Node.js-only startup work, imported by instrumentation.ts solely under the nodejs runtime guard.
// Safe to use node: imports here (via lib/runner/bundle) — this file never reaches the edge build.
//
// Logs the runner bundle version + build id the app is about to serve to agents. The app serves
// runner files off its OWN disk (lib/runner/bundle RUNNER_ROOT = <cwd>/../runner), so a stale
// checkout silently keeps serving an old version — an agent that "won't update" is almost always the
// app running pre-pull code. This line makes the served version obvious in the server log, so you
// never have to curl /api/runner/manifest to find out what the app thinks it's shipping.
import { runnerBundle } from "@/lib/runner/bundle";

try {
  const b = runnerBundle();
  console.log(
    `[runner-bundle] serving v${b.version ?? "?"} · build ${b.buildId} · ${b.files.length} files`,
  );
} catch (err) {
  // Never let a startup log crash the server — a missing/half-swapped runner tree just means we
  // can't report the version yet, not that the app should fail to boot.
  console.warn(`[runner-bundle] could not read runner bundle at startup: ${(err as Error).message}`);
}

// ── self-heal watchdog ──────────────────────────────────────────────────────────────────────────
// Starts once per server boot and keeps running even when the route module graph breaks (that
// breakage is exactly what it exists to detect — see lib/watchdog/self-heal.ts). Probes our own
// /api/health/probe over loopback; on sustained failure it announces, waits a grace period, and —
// only when a supervisor (launchd / Azure App Service) will relaunch us — exits.
import { createSelfHeal, createRestartBudget } from "@/lib/watchdog/self-heal";
import { isSupervised } from "@/lib/supervised";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SELF_HEAL_FLAG = "__iamSelfHealStarted" as const;
const g = globalThis as typeof globalThis & { [SELF_HEAL_FLAG]?: boolean };
if (!g[SELF_HEAL_FLAG]) {
  g[SELF_HEAL_FLAG] = true;
  // The port we serve on: PORT env (Azure / npm start), else the -p argument (next dev), else 3000.
  const argPort = (() => {
    const i = process.argv.indexOf("-p");
    return i >= 0 ? Number(process.argv[i + 1]) : NaN;
  })();
  const port = Number(process.env.PORT) || argPort || 3000;
  const budgetFile = join(tmpdir(), `iam-web-selfheal-${port}.json`);
  const wd = createSelfHeal({
    probe: async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health/probe`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
        let body: unknown = null;
        try { body = await res.json(); } catch { body = null; }
        return { status: res.status, body };
      } catch {
        return null; // loopback fetch failed — the listener itself is wedged
      }
    },
    supervised: isSupervised(),
    exit: () => process.exit(0),
    log: (m) => console.error(m),
    audit: async (action, detail) => {
      const { db } = await import("@/lib/db");
      await db.auditLog.create({ data: { actor: "system:self-heal", action, detail: detail as never } });
    },
    restartBudget: createRestartBudget({
      read: () => { try { return readFileSync(budgetFile, "utf8"); } catch { return "[]"; } },
      write: (s) => writeFileSync(budgetFile, s),
      max: 3,
      windowMs: 60 * 60_000,
      now: () => Date.now(),
    }),
  });
  // First tick after a warm-up delay — a booting dev server compiles on demand and a probe during
  // first compile would count as a failure it doesn't deserve. unref'd so the watchdog never keeps
  // a shutting-down process alive.
  const warmup = setTimeout(() => {
    void wd.tick(Date.now());
    const loop = setInterval(() => void wd.tick(Date.now()), 20_000);
    loop.unref?.();
  }, 30_000);
  warmup.unref?.();
}
