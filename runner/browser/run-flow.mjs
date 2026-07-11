#!/usr/bin/env node
// Entry point for the runner's browser flows. Reads ONE JSON job spec from stdin, dispatches to a
// flow in flows/, and prints ONE JSON result to stdout. The PowerShell side (Coretelligent.Browser)
// feeds the spec on stdin and parses the last stdout line.
//
// stdin  : { "flow": "<name>", "input": { "username": "...", "password": "...", "params": {...} } }
// stdout : { "ok": bool, "message"?: string, "evidence"?: string, "retryAfterMinutes"?: number, "error"?: string }
// exit   : 0 when ok, non-zero otherwise (the runner reads stdout either way).
//
// The password is NEVER logged or echoed back — only booleans/messages/evidence-paths leave here.
import process from "node:process";
import { launch } from "./lib/launch.mjs";

// Registry of available flows. Each module default-exports async ({ page, input, shot, log }) => result.
const FLOWS = {
  "spanning-force-sync": () => import("./flows/spanning-force-sync.mjs"),
};

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { buf += c; });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });
}

// Only structured, non-secret text ever reaches stderr (progress/diagnostics). Never the password.
function log(msg) {
  process.stderr.write(`[browser] ${msg}\n`);
}

// Print the single result line + set the exit code. Kept tolerant: a result is always emitted so the
// PowerShell caller never has to interpret "no output" as anything but a crash.
function emit(result) {
  const out = {
    ok: Boolean(result?.ok),
    message: result?.message ?? null,
    evidence: result?.evidence ?? null,
    ...(result?.retryAfterMinutes != null ? { retryAfterMinutes: Number(result.retryAfterMinutes) } : {}),
    ...(result?.ok ? {} : { error: result?.error ?? "unknown error" }),
  };
  process.stdout.write(JSON.stringify(out) + "\n");
  process.exitCode = out.ok ? 0 : 1;
}

async function main() {
  let spec;
  try {
    const raw = await readStdin();
    spec = JSON.parse(raw);
  } catch (e) {
    emit({ ok: false, error: `could not read/parse the job spec on stdin: ${e?.message ?? e}` });
    return;
  }

  const flowName = spec?.flow;
  const input = spec?.input ?? {};
  const loader = FLOWS[flowName];
  if (!loader) {
    emit({ ok: false, error: `unknown flow "${flowName}" — known flows: ${Object.keys(FLOWS).join(", ")}` });
    return;
  }

  let flowModule;
  try {
    flowModule = await loader();
  } catch (e) {
    emit({ ok: false, error: `could not load flow "${flowName}": ${e?.message ?? e}` });
    return;
  }
  const run = flowModule.default;

  let harness;
  try {
    harness = await launch();
  } catch (e) {
    // A launch failure (usually a missing Chromium binary) — actionable, no browser to screenshot.
    emit({ ok: false, error: String(e?.message ?? e) });
    return;
  }

  try {
    const result = await run({ page: harness.page, shot: harness.shot, input, log });
    emit(result ?? { ok: false, error: `flow "${flowName}" returned no result` });
  } catch (e) {
    // A flow SHOULD return a structured error rather than throw, but if it throws we still emit a
    // clean result (with a best-effort screenshot) — never leak a stack with credentials in it.
    let evidence = null;
    try { evidence = await harness.shot(`${flowName}-throw`); } catch { /* ignore */ }
    emit({ ok: false, error: `flow "${flowName}" threw: ${e?.message ?? e}`, evidence });
  } finally {
    await harness.close();
  }
}

main();
