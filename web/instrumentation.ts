// Next's server-startup hook (enabled via experimental.instrumentationHook). Runs once per server
// boot, before any request is served — but it is compiled for BOTH the Node.js and the edge
// (middleware) runtimes.
//
// The actual work reads the runner tree (node:fs) and hashes it (node:crypto), which the edge
// runtime cannot bundle. So we keep every node-only import in ./instrumentation.node and pull it in
// ONLY under the nodejs-runtime guard — a runtime check alone is not enough, because webpack would
// still try (and fail) to bundle a directly-imported node module for the edge build. The separate
// file keeps it out of the edge graph entirely.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation.node");
  }
}
