#!/usr/bin/env node
// The self-healing fix lane's worker. Two modes:
//
//   --task <id>   ANALYZE: run a tool-calling LLM session (provider from the LlmProvider registry)
//                 that reads the repo READ-ONLY (search_repo / read_file) and must finish with
//                 propose_fix (a structured edit list stored on the row for on-screen review) or
//                 no_fix. Nothing is written in this mode.
//   --apply <id>  APPLY: an operator reviewed the proposal and clicked Apply — patch an ISOLATED
//                 git worktree (drift-checked against the stored oldText), run tsc + tests, push
//                 the branch and open a DRAFT PR. A human always merges. See docs/FIX_LANE.md.
//
// Guardrails (by construction, not convention):
//   - the analyze session is read-only: its only tools are git grep + bounded file reads inside
//     the repo (no .env/secret paths), and its terminal tools just store JSON on the FixTask row;
//   - caps: 20 tool turns, 10-minute wall clock, bounded tool output — any provider/HTTP error
//     marks the task "failed" (never a silent "no_change");
//   - apply never touches your checkout: it works in a throwaway worktree under /tmp, removed in
//     a finally block whatever happens; every edit re-validates oldText before writing (drift ⇒
//     refuse); the PR is always a draft; the script never merges and never force-pushes.
//
// Plain Node, no deps beyond node builtins + web/node_modules/@prisma/client (loaded from the
// repo the script lives in, so it works from any checkout).
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_TURNS = 20; // LLM tool rounds per analyze session
const ANALYZE_TIMEOUT_MS = 10 * 60_000; // wall-clock cap on the analyze session
const FETCH_TIMEOUT_MS = 120_000; // per provider request
const TOOL_OUTPUT_CAP = 8_000; // chars per tool result handed back to the model
const LOG_TAIL = 8_000; // FixTask.log keeps at most this many chars
const MAX_EDITS = 12; // sanity cap on a single proposal

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

// The analyze session's framing. Deliberately narrow: root-cause + minimal fix, and it MUST end
// with propose_fix (structured edits for human review) or no_fix — it never writes anything.
/** @param {{ title: string; context: string }} task @returns {{ system: string; user: string }} */
export function buildFixPrompt(task) {
  return {
    system: [
      "You are the iam-engine fix lane: a one-shot, READ-ONLY debugging session over a checkout of this repo.",
      "The app code is in web/ (Next.js + TypeScript + Prisma) and the executors are in runner/ (PowerShell 7 modules under runner/modules).",
      "You have tools to search the repo (search_repo) and read files (read_file). You cannot edit anything —",
      "instead you finish by calling exactly one of:",
      "  - propose_fix: the MINIMAL code fix as a list of exact text replacements (file + startLine/endLine + oldText copied VERBATIM from read_file output, without the line-number prefixes + newText). A human reviews the proposal on screen and applies it.",
      "  - no_fix: when the failure is environmental (bad credentials, a vendor outage, missing license seats, misconfiguration in data rather than code) or you cannot find the root cause. Never propose speculative changes.",
      "Rules: keep edits minimal — no refactors, no unrelated fixes, no doc/config changes unless they ARE the root cause.",
      "oldText must match the current file contents exactly and be unique within the file (include enough surrounding lines to make it unique).",
    ].join("\n"),
    user: [
      "A run-log line from the IAM automation platform failed and was handed to you to diagnose.",
      "",
      `Failure: ${task.title}`,
      "Run-log context (module/system, case number, error messages):",
      "```",
      task.context,
      "```",
      "",
      "Find the root cause (search for the error text and the module named above), read the relevant code, then call propose_fix with the minimal fix and a one-paragraph diagnosis — or no_fix with your reasoning.",
    ].join("\n"),
  };
}

// Neutral tool definitions; each adapter reshapes them to its wire format.
export const FIX_TOOLS = [
  {
    name: "search_repo",
    description: "Search the repository with git grep (extended regex). Returns matching lines as path:line:text. Use pathGlob to narrow (e.g. 'web/**' or 'runner/**').",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex to search for" },
        pathGlob: { type: "string", description: "Optional pathspec to limit the search, e.g. web/** or runner/modules/**" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "read_file",
    description: "Read a repo file (path relative to the repo root). Returns numbered lines. Use startLine/endLine to window large files.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo-relative path, e.g. web/lib/cases/repository.ts" },
        startLine: { type: "integer", description: "1-based first line (optional)" },
        endLine: { type: "integer", description: "1-based last line (optional)" },
      },
      required: ["path"],
    },
  },
  {
    name: "propose_fix",
    description: "Finish with the minimal fix as exact text replacements. Each edit's oldText must be copied verbatim from the file (no line-number prefixes) and be unique within that file.",
    input_schema: {
      type: "object",
      properties: {
        diagnosis: { type: "string", description: "One paragraph: what was broken, why, and what the edits change" },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              file: { type: "string", description: "Repo-relative path" },
              startLine: { type: "integer", description: "1-based first line the edit touches (for display)" },
              endLine: { type: "integer", description: "1-based last line the edit touches (for display)" },
              oldText: { type: "string", description: "Exact current text to replace (verbatim, unique in the file)" },
              newText: { type: "string", description: "Replacement text" },
              note: { type: "string", description: "Optional one-liner on what this edit does" },
            },
            required: ["file", "startLine", "endLine", "oldText", "newText"],
          },
        },
      },
      required: ["diagnosis", "edits"],
    },
  },
  {
    name: "no_fix",
    description: "Finish WITHOUT proposing changes: the failure is environmental (credentials, vendor outage, seats, data/config) or the root cause could not be located.",
    input_schema: {
      type: "object",
      properties: { reason: { type: "string", description: "One paragraph explaining why no code change is proposed" } },
      required: ["reason"],
    },
  },
];

// Neutral conversation shape used by both adapters:
//   { role: "user", text } |
//   { role: "assistant", text, toolCalls: [{ id, name, args }] } |
//   { role: "tool_results", results: [{ id, name, output }] }
// Each adapter turns that into its wire format (and parses responses back into it).

/** Anthropic Messages API adapter. */
export const anthropicAdapter = {
  url: (p) => `${p.baseUrl.replace(/\/+$/, "")}/v1/messages`,
  headers: (p) => ({ "content-type": "application/json", "x-api-key": p.apiKey, "anthropic-version": "2023-06-01" }),
  body(p, system, convo, tools) {
    const messages = [];
    for (const m of convo) {
      if (m.role === "user") messages.push({ role: "user", content: [{ type: "text", text: m.text }] });
      else if (m.role === "assistant") {
        const content = [];
        if (m.text) content.push({ type: "text", text: m.text });
        for (const c of m.toolCalls ?? []) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.args });
        messages.push({ role: "assistant", content });
      } else if (m.role === "tool_results") {
        messages.push({ role: "user", content: m.results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.output })) });
      }
    }
    return {
      model: p.model,
      max_tokens: 4096,
      system,
      messages,
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
    };
  },
  parse(json) {
    const blocks = Array.isArray(json?.content) ? json.content : [];
    return {
      text: blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n"),
      toolCalls: blocks.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, args: b.input ?? {} })),
    };
  },
};

/** OpenAI-compatible chat/completions adapter (OpenAI, OpenRouter, Azure AI, Hugging Face…). */
export const openAiAdapter = {
  url: (p) => `${p.baseUrl.replace(/\/+$/, "")}/chat/completions`,
  // Bearer covers OpenAI/OpenRouter/HF; Azure's OpenAI-compatible /openai/v1 endpoint accepts
  // api-key — send both so one registry entry works everywhere.
  headers: (p) => ({ "content-type": "application/json", authorization: `Bearer ${p.apiKey}`, "api-key": p.apiKey }),
  body(p, system, convo, tools) {
    const messages = [{ role: "system", content: system }];
    for (const m of convo) {
      if (m.role === "user") messages.push({ role: "user", content: m.text });
      else if (m.role === "assistant") {
        messages.push({
          role: "assistant",
          content: m.text || null,
          ...(m.toolCalls?.length
            ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
            : {}),
        });
      } else if (m.role === "tool_results") {
        for (const r of m.results) messages.push({ role: "tool", tool_call_id: r.id, content: r.output });
      }
    }
    return {
      model: p.model,
      messages,
      tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })),
    };
  },
  parse(json) {
    const msg = json?.choices?.[0]?.message ?? {};
    const toolCalls = (msg.tool_calls ?? []).map((c) => {
      let args = {};
      try { args = JSON.parse(c.function?.arguments ?? "{}"); } catch { /* malformed args → empty */ }
      return { id: c.id, name: c.function?.name, args };
    });
    return { text: typeof msg.content === "string" ? msg.content : "", toolCalls };
  },
};

export function adapterFor(provider) {
  if (provider.adapter === "anthropic") return anthropicAdapter;
  if (provider.adapter === "openai-compatible") return openAiAdapter;
  throw new Error(`unknown provider adapter "${provider.adapter}"`);
}

// Drift check: an edit is applicable iff its oldText occurs EXACTLY ONCE in the file right now.
/** @param {string} fileText @param {string} oldText @returns {{ ok: boolean; count: number }} */
export function checkEdit(fileText, oldText) {
  if (!oldText) return { ok: false, count: 0 };
  let count = 0;
  for (let i = fileText.indexOf(oldText); i !== -1; i = fileText.indexOf(oldText, i + 1)) count++;
  return { ok: count === 1, count };
}

/** @param {string} fileText @param {{ oldText: string; newText: string }} edit */
export function applyEdit(fileText, edit) {
  return fileText.replace(edit.oldText, edit.newText);
}

// Structural validation of a propose_fix payload (content/drift is checked separately per file).
/** @returns {string | null} an error message, or null when valid */
export function validateProposalShape(args) {
  if (!args || typeof args.diagnosis !== "string" || !args.diagnosis.trim()) return "propose_fix needs a non-empty diagnosis";
  if (!Array.isArray(args.edits) || args.edits.length === 0) return "propose_fix needs at least one edit";
  if (args.edits.length > MAX_EDITS) return `too many edits (${args.edits.length} > ${MAX_EDITS}) — keep the fix minimal`;
  for (const e of args.edits) {
    if (!e || typeof e.file !== "string" || !e.file.trim()) return "every edit needs a repo-relative file";
    if (typeof e.oldText !== "string" || !e.oldText.trim()) return `edit for ${e?.file}: oldText is required`;
    if (typeof e.newText !== "string") return `edit for ${e.file}: newText is required (may be empty to delete)`;
    if (e.oldText === e.newText) return `edit for ${e.file}: oldText and newText are identical`;
    if (!Number.isInteger(e.startLine) || !Number.isInteger(e.endLine) || e.startLine < 1 || e.endLine < e.startLine) {
      return `edit for ${e.file}: startLine/endLine must be sane 1-based integers`;
    }
  }
  return null;
}

// Repo-relative path guard for read_file: stay inside the repo, never secrets/deps/VCS internals.
/** @param {string} p @returns {string | null} an error message, or null when allowed */
export function readPathProblem(p) {
  if (typeof p !== "string" || !p.trim()) return "path is required";
  if (path.isAbsolute(p) || p.split(/[\\/]/).includes("..")) return "path must be repo-relative (no absolute paths, no ..)";
  const base = path.basename(p);
  if (/^\.env/i.test(base) || /secret|credential/i.test(p)) return "that path is off-limits (secrets)";
  if (p.split(/[\\/]/).some((seg) => seg === "node_modules" || seg === ".git")) return "node_modules/.git are off-limits";
  return null;
}

export const maskKey = (k) => (typeof k === "string" && k.length > 4 ? `…${k.slice(-4)}` : "••••");

const tail = (s) => (s && s.length > LOG_TAIL ? s.slice(-LOG_TAIL) : s ?? "");
const cap = (s, n = TOOL_OUTPUT_CAP) => (s && s.length > n ? `${s.slice(0, n)}\n… (truncated)` : s ?? "");

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

// ── analyze mode: the read-only tool loop ────────────────────────────────────────────────────────

function execSearchRepo(mainRoot, args) {
  const pattern = typeof args?.pattern === "string" ? args.pattern : "";
  if (!pattern.trim()) return "search_repo needs a pattern";
  const gitArgs = ["-C", mainRoot, "grep", "-nI", "--extended-regexp", "-e", pattern, "--"];
  if (typeof args.pathGlob === "string" && args.pathGlob.trim()) gitArgs.push(args.pathGlob.trim());
  const r = run("git", gitArgs);
  if (r.code === 1 && !r.stdout) return "no matches";
  if (r.code !== 0 && !r.stdout) return `search failed: ${r.stderr || `git grep exited ${r.code}`}`;
  return cap(r.stdout);
}

function execReadFile(mainRoot, args) {
  const problem = readPathProblem(args?.path);
  if (problem) return problem;
  const abs = path.join(mainRoot, args.path);
  if (!existsSync(abs)) return `no such file: ${args.path}`;
  let text;
  try { text = readFileSync(abs, "utf8"); } catch (e) { return `read failed: ${e.message}`; }
  const lines = text.split("\n");
  const start = Number.isInteger(args.startLine) && args.startLine > 0 ? args.startLine : 1;
  const end = Number.isInteger(args.endLine) && args.endLine >= start ? Math.min(args.endLine, lines.length) : Math.min(start + 399, lines.length);
  return cap(lines.slice(start - 1, end).map((l, i) => `${start + i}\t${l}`).join("\n"));
}

// Validate a proposal against the CURRENT files (existence + oldText uniqueness). Returns the
// per-edit problems to hand back to the model, or null when everything applies cleanly.
function proposalProblems(mainRoot, edits) {
  const problems = [];
  for (const e of edits) {
    const pathProblem = readPathProblem(e.file);
    if (pathProblem) { problems.push(`${e.file}: ${pathProblem}`); continue; }
    const abs = path.join(mainRoot, e.file);
    if (!existsSync(abs)) { problems.push(`${e.file}: no such file`); continue; }
    const check = checkEdit(readFileSync(abs, "utf8"), e.oldText);
    if (!check.ok) problems.push(`${e.file}: oldText matches ${check.count} times (must be exactly 1) — copy it verbatim from read_file output, without line-number prefixes, with enough context to be unique`);
  }
  return problems.length ? problems.join("\n") : null;
}

async function providerRequest(provider, adapter, system, convo) {
  const res = await fetch(adapter.url(provider), {
    method: "POST",
    headers: adapter.headers(provider),
    body: JSON.stringify(adapter.body(provider, system, convo, FIX_TOOLS)),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const bodyText = await res.text();
  if (!res.ok) throw new Error(`${provider.name} (${provider.model}) returned ${res.status}: ${cap(bodyText, 1500)}`);
  let json;
  try { json = JSON.parse(bodyText); } catch { throw new Error(`${provider.name} returned non-JSON (${res.status})`); }
  return adapter.parse(json);
}

async function analyze(db, task, mainRoot) {
  const finish = (status, fields = {}) =>
    db.fixTask.update({ where: { id: task.id }, data: { status, finishedAt: new Date(), ...fields } });

  const provider = (await db.llmProvider.findFirst({ where: { isDefault: true } })) ?? (await db.llmProvider.findFirst());
  if (!provider) { await finish("failed", { log: "no LLM provider configured — add one under Settings → LLM providers" }); return; }

  const adapter = adapterFor(provider);
  await db.fixTask.update({ where: { id: task.id }, data: { status: "running", provider: `${provider.name} (${provider.model})` } });

  const { system, user } = buildFixPrompt(task);
  const convo = [{ role: "user", text: user }];
  const deadline = Date.now() + ANALYZE_TIMEOUT_MS;
  let nudged = false;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (Date.now() > deadline) { await finish("failed", { log: "timeout: the analyze session exceeded 10 minutes" }); return; }
    const parsed = await providerRequest(provider, adapter, system, convo);
    convo.push({ role: "assistant", text: parsed.text, toolCalls: parsed.toolCalls });

    if (parsed.toolCalls.length === 0) {
      // A bare text reply is not a terminal state — nudge once, then fail rather than guess.
      if (nudged) { await finish("failed", { log: tail(`the model never called propose_fix/no_fix; last reply:\n${parsed.text}`) }); return; }
      nudged = true;
      convo.push({ role: "user", text: "You must finish by calling propose_fix (with exact edits) or no_fix (with a reason). Call one of them now." });
      continue;
    }

    const results = [];
    let done = false;
    for (const call of parsed.toolCalls) {
      if (call.name === "no_fix") {
        const reason = typeof call.args?.reason === "string" && call.args.reason.trim() ? call.args.reason.trim() : parsed.text || "no reason given";
        await finish("no_change", { log: tail(reason) });
        done = true;
        break;
      }
      if (call.name === "propose_fix") {
        const shapeProblem = validateProposalShape(call.args);
        const driftProblem = shapeProblem ? null : proposalProblems(mainRoot, call.args.edits);
        if (!shapeProblem && !driftProblem) {
          await finish("proposed", {
            log: tail(call.args.diagnosis),
            proposal: {
              diagnosis: call.args.diagnosis,
              edits: call.args.edits.map((e) => ({ file: e.file, startLine: e.startLine, endLine: e.endLine, oldText: e.oldText, newText: e.newText, ...(e.note ? { note: e.note } : {}) })),
            },
          });
          done = true;
          break;
        }
        results.push({ id: call.id, name: call.name, output: `proposal rejected:\n${shapeProblem ?? driftProblem}\nFix the edits and call propose_fix again (or no_fix).` });
        continue;
      }
      if (call.name === "search_repo") { results.push({ id: call.id, name: call.name, output: execSearchRepo(mainRoot, call.args) }); continue; }
      if (call.name === "read_file") { results.push({ id: call.id, name: call.name, output: execReadFile(mainRoot, call.args) }); continue; }
      results.push({ id: call.id, name: call.name, output: `unknown tool ${call.name}` });
    }
    if (done) return;
    convo.push({ role: "tool_results", results });
  }
  await finish("failed", { log: `the analyze session used all ${MAX_TURNS} tool turns without finishing` });
}

// ── apply mode: worktree → drift check → tsc/tests → draft PR ────────────────────────────────────

async function apply(db, task, mainRoot) {
  const finish = (status, fields = {}) =>
    db.fixTask.update({ where: { id: task.id }, data: { status, finishedAt: new Date(), ...fields } });

  const proposal = task.proposal;
  if (!proposal || !Array.isArray(proposal.edits) || proposal.edits.length === 0) {
    await finish("failed", { log: "apply requested but the task has no stored proposal" });
    return;
  }

  const branch = `claude-fixes/${task.id}`;
  const wt = `/tmp/iam-fix-${task.id}`;
  let pushed = false;
  let worktreeAdded = false;

  try {
    // Branch from the up-to-date default branch, NOT the primary checkout's local HEAD (which may
    // sit on a stale commit or an unrelated feature branch). The PR diff is then just the fix.
    run("git", ["-C", mainRoot, "fetch", "origin", "--quiet"]);
    const defaultBranch =
      run("git", ["-C", mainRoot, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).stdout.replace(/^origin\//, "") || "main";
    const base = `origin/${defaultBranch}`;

    must("git", ["-C", mainRoot, "worktree", "add", wt, "-b", branch, base]);
    worktreeAdded = true;
    await db.fixTask.update({ where: { id: task.id }, data: { branch } });

    // Re-validate EVERY edit against the worktree before touching anything: the proposal was made
    // against the code as of analyze time; if the file drifted, refuse rather than mis-apply.
    for (const e of proposal.edits) {
      const abs = path.join(wt, e.file);
      if (!existsSync(abs)) { await finish("failed", { log: `drifted: ${e.file} no longer exists on ${base} — re-run the analysis` }); return; }
      const check = checkEdit(readFileSync(abs, "utf8"), e.oldText);
      if (!check.ok) { await finish("failed", { log: `drifted: ${e.file} no longer matches the proposal (oldText found ${check.count}×) — re-run the analysis` }); return; }
    }
    for (const e of proposal.edits) {
      const abs = path.join(wt, e.file);
      writeFileSync(abs, applyEdit(readFileSync(abs, "utf8"), e));
    }

    const module = moduleFromTitle(task.title);
    must("git", ["-C", wt, "add", "-A"]);
    must("git", ["-C", wt, "commit", "-m", `fix(${module}): ${task.title}\n\n${proposal.diagnosis}\n\nProposed by ${task.provider ?? "the fix lane"}; reviewed and applied by ${task.appliedBy ?? "an operator"}.`]);

    // web/node_modules and web/.env are gitignored — share the main checkout's node_modules so
    // tsc/tests resolve; never bring the .env (tests must not reach a real database).
    const wtWeb = path.join(wt, "web");
    if (!existsSync(path.join(wtWeb, "node_modules")) && existsSync(path.join(mainRoot, "web", "node_modules"))) {
      symlinkSync(path.join(mainRoot, "web", "node_modules"), path.join(wtWeb, "node_modules"));
    }
    const testEnv = { ...process.env };
    delete testEnv.DATABASE_URL;

    const tsc = run("npx", ["tsc", "--noEmit", "-p", "."], { cwd: wtWeb, env: testEnv, timeout: 5 * 60_000 });
    if (tsc.code !== 0) { await finish("failed", { log: tail(`tsc failed after applying the edits:\n${tsc.stdout || tsc.stderr}`) }); return; }
    if (proposal.edits.some((e) => e.file.startsWith("web/"))) {
      const tests = run("npm", ["test"], { cwd: wtWeb, env: testEnv, timeout: 10 * 60_000 });
      if (tests.code !== 0) { await finish("failed", { log: tail(`web tests failed after applying the edits:\n${tests.stdout || tests.stderr}`) }); return; }
    }

    // Draft PR. Never merges; a human reviews.
    must("git", ["-C", wt, "push", "-u", "origin", branch]);
    pushed = true;
    const body = `${proposal.diagnosis}\n\nAuto-generated by the iam-engine fix lane (${task.provider ?? "unknown provider"}) from run-log fingerprint ${task.fingerprint}; reviewed on-screen and applied by ${task.appliedBy ?? "an operator"}.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`;
    const pr = must("gh", ["pr", "create", "--draft", "--base", defaultBranch, "--title", `fix(${module}): ${task.title}`, "--body", body, "--head", branch], { cwd: wt });
    const prUrl = pr.stdout.split("\n").find((l) => l.startsWith("https://")) ?? pr.stdout;
    await finish("opened_pr", { prUrl });
  } finally {
    // ALWAYS clean up: remove the temp worktree; drop the local branch ref only if never pushed.
    if (worktreeAdded) run("git", ["-C", mainRoot, "worktree", "remove", "--force", wt]);
    if (!pushed) run("git", ["-C", mainRoot, "branch", "-D", branch]);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const taskIdx = process.argv.indexOf("--task");
  const applyIdx = process.argv.indexOf("--apply");
  const mode = applyIdx >= 0 ? "apply" : "analyze";
  const taskId = applyIdx >= 0 ? process.argv[applyIdx + 1] : taskIdx >= 0 ? process.argv[taskIdx + 1] : null;
  if (!taskId) { console.error("usage: node scripts/llm-fix.mjs --task <FixTask id> | --apply <FixTask id>"); process.exit(2); }

  // db + task are resolved INSIDE the try so a failure here (bad git repo, missing DATABASE_URL, DB
  // down) is caught and — once we have a db handle — recorded on the row, instead of the detached
  // worker (stdio ignored) dying as a silent unhandled rejection and wedging the task at "queued".
  let db = null;
  let task = null;
  try {
    const mainRoot = findMainRepoRoot();
    db = loadPrisma(mainRoot);
    task = await db.fixTask.findUnique({ where: { id: taskId } });
    if (!task) { console.error(`FixTask ${taskId} not found`); await db.$disconnect(); process.exit(2); }
    if (mode === "apply") await apply(db, task, mainRoot);
    else await analyze(db, task, mainRoot);
  } catch (e) {
    // Record on the row when we have a DB handle; otherwise (findMainRepoRoot / loadPrisma failed
    // before we connected) there's nowhere to write it — surface to stderr so the launcher's
    // captured output isn't empty, and exit non-zero.
    if (db && task) {
      await db.fixTask.update({ where: { id: task.id }, data: { status: "failed", finishedAt: new Date(), log: tail(String(e?.stack ?? e)) } }).catch(() => {});
    } else console.error(`fix worker aborted before it could record status: ${e?.stack ?? e}`);
    process.exitCode = 1;
  } finally {
    if (db) await db.$disconnect().catch(() => {});
  }
}

// Importable for tests (the pure helpers above) without running the worker.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}
