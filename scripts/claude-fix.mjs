#!/usr/bin/env node
// The self-healing fix lane's worker: takes a FixTask id (--task <id>), runs a headless Claude
// Code session against an ISOLATED git worktree, and — only when Claude committed a change —
// pushes the branch and opens a DRAFT PR. A human always merges. See docs/FIX_LANE.md.
//
// Guardrails (by construction, not convention):
//   - the fixer never touches your checkout: it works in a throwaway worktree under /tmp, removed
//     in a finally block whatever happens;
//   - Claude runs with --max-turns 25, a 15-minute hard timeout, and an allowlisted tool set
//     (read/edit/grep + npm test / npx tsc / git diff|add|commit only — no push, no gh, no rm);
//   - repo hooks/skills are disabled inside the fixer (--bare, or --settings disableAllHooks);
//   - the PR is always a draft; the script never merges and never force-pushes.
//
// Plain Node, no deps beyond node builtins + web/node_modules/@prisma/client (loaded from the
// repo the script lives in, so it works from any checkout).
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLAUDE_TIMEOUT_MS = 15 * 60_000; // hard cap on the headless run
const LOG_TAIL = 8000; // FixTask.log keeps at most this many chars

// ── small pure helpers (unit-tested from web/lib/fixes) ─────────────────────────────────────────

// Minimal KEY=VALUE .env parser — enough for web/.env (comments, blank lines, optional quotes).
/** @param {string} text @returns {Record<string, string>} */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

// The module/system prefix out of a task title like "m365: license assignment failed" → "m365".
/** @param {string} title @returns {string} */
export function moduleFromTitle(title) {
  const m = /^([a-z0-9_.-]+)\s*:/i.exec(title ?? "");
  return m ? m[1].toLowerCase() : "fix-lane";
}

// The headless prompt. Deliberately narrow: root-cause + minimal fix + verify + commit + a
// one-paragraph diagnosis as the reply (that reply is what lands in FixTask.log and the PR body).
/** @param {{ title: string; context: string }} task @returns {string} */
export function buildPrompt(task) {
  return [
    "You are the iam-engine fix lane: a one-shot, headless debugging session in an isolated git worktree of this repo.",
    "A run-log line from the IAM automation platform failed and was handed to you to diagnose and fix.",
    "",
    `Failure: ${task.title}`,
    "Run-log context (module/system, case number, error messages):",
    "```",
    task.context,
    "```",
    "",
    "Do the following, in order:",
    "1. Find the root cause. The app code is in web/ (Next.js + TypeScript + Prisma) and the executors are in runner/ (PowerShell 7 modules under runner/modules). Search for the error text and the module named above.",
    "2. Make the MINIMAL code fix. Do not refactor, do not fix unrelated issues, do not touch docs or config unless they are the root cause.",
    "3. Verify WITHOUT `cd` (the allowlist matches the command's start): run `npx tsc --noEmit -p web` and, for a web change, `npm test --prefix web`. If you changed runner PowerShell only, tsc still must pass (it will — you didn't touch web).",
    "4. Commit your change with a descriptive message explaining the root cause and the fix.",
    "5. REPLY with a one-paragraph diagnosis: what was broken, why, and what you changed. If you could NOT find or fix the root cause, say so plainly and DO NOT commit speculative changes.",
    "",
    "Hard rules: never push, never merge, never modify git config or CI, never delete files you did not create. If the failure is environmental (bad credentials, a vendor outage, missing license seats) rather than a code bug, commit nothing and explain that in your reply.",
  ].join("\n");
}

// ── plumbing ─────────────────────────────────────────────────────────────────────────────────────

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.error) throw r.error;
  return { code: r.status ?? -1, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
}

function must(cmd, args, opts = {}) {
  const r = run(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.code}): ${r.stderr || r.stdout}`);
  return r;
}

// The repo this script lives in → the MAIN repo root (the script may be running from a worktree
// checkout; `git worktree add` must happen from the primary checkout so /tmp worktrees don't nest).
function findMainRepoRoot() {
  const scriptRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const gitDir = must("git", ["-C", scriptRepo, "rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout;
  return path.dirname(gitDir); // <main-root>/.git → <main-root>
}

function loadPrisma(mainRoot) {
  const envPath = path.join(mainRoot, "web", ".env");
  const env = parseEnvFile(existsSync(envPath) ? readFileSync(envPath, "utf8") : "");
  if (!env.DATABASE_URL) throw new Error(`DATABASE_URL not found in ${envPath}`);
  process.env.DATABASE_URL = env.DATABASE_URL;
  const require = createRequire(path.join(mainRoot, "web", "package.json"));
  const { PrismaClient } = require("@prisma/client");
  return new PrismaClient();
}

// Headless Claude Code with a hard timeout. Resolves { code, stdout, stderr, timedOut }.
// The child runs with DATABASE_URL scrubbed: loadPrisma stamped the production URL into this
// process's env for the worker's own Prisma, but the headless session's allowlisted `npm test`
// must never reach a real database (the /tmp worktree has no gitignored web/.env of its own).
function runClaude(args, cwd) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    const child = spawn("claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env });
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, CLAUDE_TIMEOUT_MS);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(e), timedOut }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr, timedOut }); });
  });
}

const tail = (s) => (s && s.length > LOG_TAIL ? s.slice(-LOG_TAIL) : s ?? "");

// ── main ─────────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const taskIdx = process.argv.indexOf("--task");
  const taskId = taskIdx >= 0 ? process.argv[taskIdx + 1] : null;
  if (!taskId) { console.error("usage: node scripts/claude-fix.mjs --task <FixTask id>"); process.exit(2); }

  // db + task are resolved INSIDE the try so a failure here (bad git repo, missing DATABASE_URL, DB
  // down) is caught and — once we have a db handle — recorded on the row, instead of the detached
  // worker (stdio ignored) dying as a silent unhandled rejection and wedging the task at "queued".
  let db = null;
  let task = null;
  const branch = `claude-fixes/${taskId}`;
  const wt = `/tmp/iam-fix-${taskId}`;
  let pushed = false;
  let worktreeAdded = false;
  let mainRoot = null; // set once findMainRepoRoot succeeds; the finally uses it to clean up

  const finish = (status, fields = {}) =>
    db.fixTask.update({ where: { id: taskId }, data: { status, finishedAt: new Date(), ...fields } });

  try {
    mainRoot = findMainRepoRoot();
    db = loadPrisma(mainRoot);
    task = await db.fixTask.findUnique({ where: { id: taskId } });
    if (!task) { console.error(`FixTask ${taskId} not found`); await db.$disconnect(); process.exit(2); }

    await db.fixTask.update({ where: { id: task.id }, data: { status: "running", branch } });

    // Branch from the up-to-date default branch, NOT the primary checkout's local HEAD (which may sit
    // on a stale commit or an unrelated feature branch — the web server runs from its own worktree, so
    // nothing keeps main-checkout HEAD current). Fetch first, resolve origin's default branch, and cut
    // the fix branch from it so Claude patches current code and the PR diff is just the fix.
    run("git", ["-C", mainRoot, "fetch", "origin", "--quiet"]);
    const defaultBranch =
      run("git", ["-C", mainRoot, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).stdout.replace(/^origin\//, "") || "main";
    const base = `origin/${defaultBranch}`;

    // Isolated throwaway worktree on its own branch — the fixer never sees your checkout.
    must("git", ["-C", mainRoot, "worktree", "add", wt, "-b", branch, base]);
    worktreeAdded = true;
    const baseSha = must("git", ["-C", wt, "rev-parse", "HEAD"]).stdout;

    // No repo hooks/skills inside the fixer: --bare where the CLI has it, else disable hooks.
    const help = run("claude", ["--help"]);
    if (help.code !== 0) throw new Error("the `claude` CLI is not installed or not on PATH (see docs/FIX_LANE.md)");
    const isolation = help.stdout.includes("--bare") ? ["--bare"] : ["--settings", '{"disableAllHooks":true}'];

    const claudeArgs = [
      "-p", buildPrompt(task),
      "--output-format", "json",
      "--max-turns", "25",
      "--permission-mode", "acceptEdits",
      // Prefix-matched: each entry must be how the command STARTS (so the prompt uses `npx tsc -p web`
      // and `npm test --prefix web`, never `cd web && …`, which wouldn't match and gets silently denied).
      "--allowedTools", "Read,Edit,Write,Glob,Grep,Bash(npm test:*),Bash(npm test --prefix web:*),Bash(npx tsc:*),Bash(git diff:*),Bash(git add:*),Bash(git commit:*)",
      ...isolation,
    ];
    const res = await runClaude(claudeArgs, wt);
    if (res.timedOut) { await finish("failed", { log: "timeout: the fixer exceeded 15 minutes and was killed" }); return; }

    // stdout is a single JSON result object (--output-format json).
    let diagnosis = "", cost = null;
    try {
      const out = JSON.parse(res.stdout);
      diagnosis = typeof out.result === "string" ? out.result : JSON.stringify(out.result ?? "");
      cost = out.total_cost_usd ?? null;
    } catch {
      diagnosis = res.stdout || res.stderr || `claude exited ${res.code} with no output`;
    }
    const log = tail(`${diagnosis}${cost != null ? `\n\n[cost: $${Number(cost).toFixed(2)}]` : ""}`);

    const headSha = must("git", ["-C", wt, "rev-parse", "HEAD"]).stdout;
    if (headSha === baseSha) { await finish("no_change", { log }); return; }

    // Claude committed something → draft PR. Never merges; a human reviews.
    must("git", ["-C", wt, "push", "-u", "origin", branch]);
    pushed = true;
    const module = moduleFromTitle(task.title);
    const body = `${diagnosis}\n\nAuto-generated by the iam-engine fix lane from run-log fingerprint ${task.fingerprint}.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`;
    const pr = must("gh", ["pr", "create", "--draft", "--base", defaultBranch, "--title", `fix(${module}): ${task.title}`, "--body", body, "--head", branch], { cwd: wt });
    const prUrl = pr.stdout.split("\n").find((l) => l.startsWith("https://")) ?? pr.stdout;
    await finish("opened_pr", { log, prUrl });
  } catch (e) {
    // Record on the row when we have a DB handle; otherwise (findMainRepoRoot / loadPrisma failed
    // before we connected) there's nowhere to write it — surface to stderr so the launcher's captured
    // output isn't empty, and exit non-zero.
    if (db && task) await finish("failed", { log: tail(String(e?.stack ?? e)) }).catch(() => {});
    else console.error(`fix worker aborted before it could record status: ${e?.stack ?? e}`);
    process.exitCode = 1;
  } finally {
    // ALWAYS clean up: remove the temp worktree; drop the local branch ref only if never pushed.
    if (worktreeAdded && mainRoot) run("git", ["-C", mainRoot, "worktree", "remove", "--force", wt]);
    if (!pushed && mainRoot) run("git", ["-C", mainRoot, "branch", "-D", branch]);
    if (db) await db.$disconnect().catch(() => {});
  }
}

// Importable for tests (parseEnvFile / buildPrompt / moduleFromTitle) without running the worker.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}
