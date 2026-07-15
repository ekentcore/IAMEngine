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
