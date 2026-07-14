#!/usr/bin/env node
// Azure OpenAI probe: works out WHICH request recipe a given deployment actually accepts.
//
// Why this exists: gpt-4o works with the call we already make, but the gpt-5 family (and the
// o-series) reject it. They are reasoning models, and Azure changed the contract for them:
//   * `max_tokens` is REJECTED — they want `max_completion_tokens`
//     (see the api-version changelog: "max_tokens doesn't work with the o1 series models")
//   * `temperature` other than the default is REJECTED
//   * they burn tokens on hidden reasoning BEFORE writing any answer, so too small a budget
//     returns HTTP 200 with an EMPTY message and finish_reason "length" — a silent failure that
//     looks like the model said nothing
//   * a stale pinned ?api-version= may not know a newer model at all
// Rather than guess which of those bit you, this tries every combination and prints what happened.
//
// Docs: https://learn.microsoft.com/en-us/azure/ai-foundry/openai/api-version-lifecycle
//   The v1 surface (<endpoint>/openai/v1/) needs NO api-version, and Microsoft now recommends the
//   Responses API for Azure OpenAI models. Both are probed here alongside the classic path.
//
// Usage:
//   node scripts/azure-llm-probe.mjs                          # probe every deployment Azure lists
//   node scripts/azure-llm-probe.mjs gpt-4o gpt-5.6-luna      # probe just these deployments
//   node scripts/azure-llm-probe.mjs --list                   # only list deployments, probe nothing
//   node scripts/azure-llm-probe.mjs --prompt "2+2?" --json
//
// Env (read from the process, else from env.env / web/.env at the repo root):
//   AZURE_OPENAI_ENDPOINT   https://your-resource.openai.azure.com
//   AZURE_OPENAI_KEY        the resource key            (AZUREAI_API / AZURE_OPENAI_API_KEY also accepted)
//   AZURE_OPENAI_VERSION    optional; the pinned api-version to probe on the classic path
//
// The key is never printed. Exits 1 if a named deployment has no working recipe.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

// ── env ──────────────────────────────────────────────────────────────────────

// Minimal KEY=VALUE reader: enough for these files, deliberately not a dotenv dependency.
function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Later definitions win, mirroring how the app's loader behaves.
    if (key) out[key] = value;
  }
  return out;
}

function loadEnv() {
  const merged = {};
  for (const file of [join(REPO, "env.env"), join(REPO, "web", ".env")]) {
    if (existsSync(file)) Object.assign(merged, parseEnvFile(readFileSync(file, "utf8")));
  }
  Object.assign(merged, process.env); // a real env var always wins
  const pick = (...names) => names.map((n) => merged[n]).find((v) => v && v.trim());
  return {
    endpoint: (pick("AZURE_OPENAI_ENDPOINT", "AZUREAI_BASE") || "").trim().replace(/\/+$/, ""),
    apiKey: (pick("AZURE_OPENAI_KEY", "AZURE_OPENAI_API_KEY", "AZUREAI_API") || "").trim(),
    apiVersion: (pick("AZURE_OPENAI_VERSION", "AZUREAI_VERSION") || "2025-01-01-preview").trim(),
    deployment: (pick("AZURE_OPENAI_DEPLOYMENT", "AZUREAI_DEPLOYMENT") || "").trim(),
  };
}

// ── recipes ──────────────────────────────────────────────────────────────────
// Each recipe is one concrete way to ask a deployment a question. Add one by appending here —
// nothing else needs to change.
//
// ctx = { endpoint, deployment, prompt, budget, apiVersion }

const RECIPES = [
  {
    id: "classic + max_tokens",
    note: "what the app sent before this probe — the o1/gpt-5 families reject max_tokens",
    url: (c) => `${c.endpoint}/openai/deployments/${encodeURIComponent(c.deployment)}/chat/completions?api-version=${encodeURIComponent(c.apiVersion)}`,
    body: (c) => ({ model: c.deployment, messages: [{ role: "user", content: c.prompt }], max_tokens: c.budget }),
    kind: "chat",
  },
  {
    id: "classic + max_completion_tokens",
    note: "the classic path, with the reasoning-model token parameter",
    url: (c) => `${c.endpoint}/openai/deployments/${encodeURIComponent(c.deployment)}/chat/completions?api-version=${encodeURIComponent(c.apiVersion)}`,
    body: (c) => ({ model: c.deployment, messages: [{ role: "user", content: c.prompt }], max_completion_tokens: c.budget }),
    kind: "chat",
  },
  {
    id: "classic + max_completion_tokens + temperature:0",
    note: "isolates whether the model also rejects a non-default temperature",
    url: (c) => `${c.endpoint}/openai/deployments/${encodeURIComponent(c.deployment)}/chat/completions?api-version=${encodeURIComponent(c.apiVersion)}`,
    body: (c) => ({ model: c.deployment, messages: [{ role: "user", content: c.prompt }], max_completion_tokens: c.budget, temperature: 0 }),
    kind: "chat",
  },
  {
    id: "classic (api-version=preview) + max_completion_tokens",
    note: "same path, newest preview contract — catches 'this api-version doesn't know that model'",
    url: (c) => `${c.endpoint}/openai/deployments/${encodeURIComponent(c.deployment)}/chat/completions?api-version=preview`,
    body: (c) => ({ model: c.deployment, messages: [{ role: "user", content: c.prompt }], max_completion_tokens: c.budget }),
    kind: "chat",
  },
  {
    id: "v1 chat/completions + max_tokens",
    note: "v1 surface needs no api-version at all",
    url: (c) => `${c.endpoint}/openai/v1/chat/completions`,
    body: (c) => ({ model: c.deployment, messages: [{ role: "user", content: c.prompt }], max_tokens: c.budget }),
    kind: "chat",
  },
  {
    id: "v1 chat/completions + max_completion_tokens",
    note: "the combination most likely to work for gpt-5 on chat/completions",
    url: (c) => `${c.endpoint}/openai/v1/chat/completions`,
    body: (c) => ({ model: c.deployment, messages: [{ role: "user", content: c.prompt }], max_completion_tokens: c.budget }),
    kind: "chat",
  },
  {
    id: "v1 responses",
    note: "the API Microsoft now recommends for Azure OpenAI models",
    url: (c) => `${c.endpoint}/openai/v1/responses`,
    body: (c) => ({ model: c.deployment, input: c.prompt, max_output_tokens: c.budget }),
    kind: "responses",
  },
  {
    id: "v1 responses (api-version=preview)",
    note: "responses, opting in to preview features",
    url: (c) => `${c.endpoint}/openai/v1/responses?api-version=preview`,
    body: (c) => ({ model: c.deployment, input: c.prompt, max_output_tokens: c.budget }),
    kind: "responses",
  },
];

// ── calling ──────────────────────────────────────────────────────────────────

// Pull the assistant text out of whichever shape came back.
function extractText(kind, json) {
  if (!json || typeof json !== "object") return "";
  if (kind === "responses") {
    if (typeof json.output_text === "string" && json.output_text) return json.output_text;
    const parts = [];
    for (const item of json.output ?? []) {
      for (const chunk of item?.content ?? []) {
        if (typeof chunk?.text === "string") parts.push(chunk.text);
      }
    }
    return parts.join("").trim();
  }
  return (json.choices?.[0]?.message?.content ?? "").trim();
}

function finishReason(kind, json) {
  if (kind === "responses") return json?.status ?? json?.incomplete_details?.reason ?? "";
  return json?.choices?.[0]?.finish_reason ?? "";
}

// How many tokens the model spent thinking before writing anything. This is the number that
// explains an empty 200: the budget was consumed by reasoning.
function reasoningTokens(json) {
  return json?.usage?.completion_tokens_details?.reasoning_tokens ?? json?.usage?.output_tokens_details?.reasoning_tokens ?? 0;
}

async function runRecipe(recipe, ctx, apiKey) {
  const url = recipe.url(ctx);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "api-key": apiKey },
      body: JSON.stringify(recipe.body(ctx)),
      signal: AbortSignal.timeout(90_000),
    });
    const ms = Date.now() - started;
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON body — keep the raw text for the error line */
    }

    if (!res.ok) {
      const err = json?.error ?? {};
      return {
        ok: false,
        status: res.status,
        ms,
        url,
        code: err.code ?? String(res.status),
        message: (err.message ?? text ?? "").slice(0, 300).replace(/\s+/g, " "),
      };
    }

    const answer = extractText(recipe.kind, json);
    const finish = finishReason(recipe.kind, json);
    const reasoned = reasoningTokens(json);
    // A 200 with no text is NOT a success — it's the budget-eaten-by-reasoning trap.
    if (!answer) {
      return {
        ok: false,
        empty: true,
        status: res.status,
        ms,
        url,
        code: finish || "empty",
        message: `HTTP 200 but the reply was EMPTY (finish_reason="${finish}", reasoning_tokens=${reasoned}). The token budget was spent thinking. Raise max_completion_tokens.`,
      };
    }
    return { ok: true, status: res.status, ms, url, answer, finish, reasoned };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - started, url, code: "network", message: e?.message ?? String(e) };
  }
}

// ── discovery ────────────────────────────────────────────────────────────────
// Ask Azure what is actually deployed. A typo'd deployment name is the other way this fails, and
// it's indistinguishable from "model unsupported" if you only look at the 404.
async function listDeployments(endpoint, apiKey) {
  // /deployments FIRST and on purpose. It returns what is actually DEPLOYED — the names you must
  // put in `model` — each with the model behind it and its status. /openai/v1/models returns the
  // ~180-entry CATALOG of models the resource could deploy, which looks like an answer and isn't:
  // a name can sit in the catalog while no deployment of it exists.
  const attempts = [
    {
      label: "/openai/deployments (what is actually deployed)",
      url: `${endpoint}/openai/deployments?api-version=2023-03-15-preview`,
      pick: (j) => (j?.data ?? []).map((d) => ({ name: d.id, model: d.model, status: d.status })),
    },
    {
      label: "/openai/v1/models (CATALOG — not necessarily deployed)",
      url: `${endpoint}/openai/v1/models`,
      pick: (j) => (j?.data ?? []).map((m) => ({ name: m.id, model: m.id, status: "(catalog)" })),
    },
  ];
  for (const a of attempts) {
    try {
      const res = await fetch(a.url, { headers: { "api-key": apiKey }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) continue;
      const rows = a.pick(await res.json()).filter((r) => r.name);
      if (rows.length) return { via: a.label, rows, names: rows.map((r) => r.name).sort() };
    } catch {
      /* try the next one */
    }
  }
  return { via: null, rows: [], names: [] };
}

// ── main ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { deployments: [], prompt: "Reply with exactly: PONG", budget: 2000, json: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--list") opts.list = true;
    else if (a === "--prompt") opts.prompt = argv[++i] ?? opts.prompt;
    else if (a === "--budget") opts.budget = Number(argv[++i]) || opts.budget;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (!a.startsWith("-")) opts.deployments.push(a);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 26).join("\n").replace(/^\/\/ ?/gm, ""));
    return;
  }

  const env = loadEnv();
  if (!env.endpoint || !env.apiKey) {
    console.error("✗ AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_KEY must be set (env, env.env, or web/.env).");
    process.exit(1);
  }

  console.log(`endpoint    ${env.endpoint}`);
  console.log(`key         …${env.apiKey.slice(-4)} (${env.apiKey.length} chars)`);
  console.log(`api-version ${env.apiVersion} (used for the "classic" recipes)\n`);

  const found = await listDeployments(env.endpoint, env.apiKey);
  if (found.rows.length) {
    console.log(`Deployments Azure reports — via ${found.via}:`);
    const pad = Math.max(...found.rows.map((r) => r.name.length));
    for (const r of found.rows) {
      const flag = r.status && r.status !== "succeeded" && r.status !== "(catalog)" ? `  ⚠ ${r.status}` : "";
      console.log(`  • ${r.name.padEnd(pad)}   model: ${r.model}${flag}`);
    }
    console.log(`\n  (the name on the left is what goes in \`model\` / the Deployment field — not the model on the right)`);
  } else {
    console.log("Could not list deployments (the key may lack permission to list). Continuing anyway.");
  }
  console.log("");

  if (opts.list) return;

  let targets = opts.deployments.length ? opts.deployments : found.names;
  if (!targets.length) targets = [env.deployment].filter(Boolean);
  if (!targets.length) {
    console.error("✗ No deployments to probe. Pass them as arguments, e.g.  node scripts/azure-llm-probe.mjs gpt-4o gpt-5.6-luna");
    process.exit(1);
  }

  // Warn loudly when a requested deployment isn't in Azure's own list — that IS the bug, often.
  for (const t of opts.deployments) {
    if (found.names.length && !found.names.includes(t)) {
      console.log(`⚠  "${t}" is NOT in the deployment list above. If every recipe 404s, the name is wrong — the deployment name is what you named it in Azure, not the model name.\n`);
    }
  }

  const report = {};
  for (const deployment of targets) {
    console.log(`\n${"═".repeat(78)}\n▶ ${deployment}\n${"═".repeat(78)}`);
    const ctx = { endpoint: env.endpoint, deployment, prompt: opts.prompt, budget: opts.budget, apiVersion: env.apiVersion };
    const results = [];
    for (const recipe of RECIPES) {
      const r = await runRecipe(recipe, ctx, env.apiKey);
      results.push({ recipe: recipe.id, note: recipe.note, ...r });
      if (r.ok) {
        console.log(`  ✓ ${recipe.id.padEnd(46)} ${String(r.status).padStart(3)}  ${r.ms}ms  reasoning=${r.reasoned}  → ${JSON.stringify(r.answer.slice(0, 60))}`);
      } else {
        console.log(`  ✗ ${recipe.id.padEnd(46)} ${String(r.status).padStart(3)}  ${r.code}`);
        console.log(`      ${r.message}`);
      }
    }
    report[deployment] = results;

    const winners = results.filter((r) => r.ok);
    console.log("");
    if (winners.length) {
      console.log(`  WORKS: ${winners.map((w) => w.recipe).join(" | ")}`);
      const best = winners[0];
      console.log(`  → use "${best.recipe}"`);
      if (best.reasoned > 0) {
        console.log(`  → this is a REASONING model (${best.reasoned} hidden tokens on a trivial prompt). Give it a real budget:`);
        console.log(`     a max_completion_tokens of 1 (our old "ping" test) returns an empty 200, not an error.`);
      }
    } else {
      console.log(`  NOTHING WORKED for "${deployment}". The messages above say why — a 404/DeploymentNotFound on every`);
      console.log(`  recipe means the deployment NAME is wrong, not the request shape.`);
    }
  }

  if (opts.json) console.log(`\n${JSON.stringify(report, null, 2)}`);

  const failed = Object.entries(report).filter(([, rs]) => !rs.some((r) => r.ok)).map(([d]) => d);
  if (failed.length) {
    console.log(`\n✗ no working recipe for: ${failed.join(", ")}`);
    process.exit(1);
  }
  console.log("\n✓ every probed deployment has at least one working recipe");
}

main().catch((e) => {
  console.error("probe crashed:", e?.message ?? e);
  process.exit(1);
});
