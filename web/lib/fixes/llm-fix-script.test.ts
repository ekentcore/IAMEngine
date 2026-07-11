// Unit tests for the fix-lane worker's pure helpers (scripts/llm-fix.mjs). The script guards
// its main() behind an argv check, so importing it here runs nothing — no worktrees, no LLM calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseEnvFile,
  buildFixPrompt,
  moduleFromTitle,
  checkEdit,
  applyEdit,
  validateProposalShape,
  readPathProblem,
  maskKey,
  adapterFor,
  anthropicAdapter,
  openAiAdapter,
  FIX_TOOLS,
} from "../../../scripts/llm-fix.mjs";

test("parseEnvFile: KEY=VALUE with quotes, comments, blanks, embedded =", () => {
  const env = parseEnvFile([
    "# comment",
    "",
    'DATABASE_URL="postgresql://u:p@host:5432/db?schema=public"',
    "PLAIN=value",
    "SINGLE='quoted'",
    "WITH_EQ=a=b=c",
    "  SPACED = padded ",
    "NOEQUALS",
    "=novalue",
  ].join("\n"));
  assert.equal(env.DATABASE_URL, "postgresql://u:p@host:5432/db?schema=public");
  assert.equal(env.PLAIN, "value");
  assert.equal(env.SINGLE, "quoted");
  assert.equal(env.WITH_EQ, "a=b=c");
  assert.equal(env.SPACED, "padded");
  assert.ok(!("NOEQUALS" in env));
  assert.ok(!("" in env));
});

test("moduleFromTitle: systemKey prefix before the colon, lowercased; fallback when none", () => {
  assert.equal(moduleFromTitle("m365: license assignment failed"), "m365");
  assert.equal(moduleFromTitle("google-workspace: user not found"), "google-workspace");
  assert.equal(moduleFromTitle("Active_Directory.v2: LDAP 53"), "active_directory.v2");
  assert.equal(moduleFromTitle("no module prefix here"), "fix-lane");
  assert.equal(moduleFromTitle(""), "fix-lane");
});

test("buildFixPrompt: carries the failure context and the read-only + terminal-tool contract", () => {
  const p = buildFixPrompt({ title: "m365: seat exhausted", context: "m365 (UM0012345)\nno seats left" });
  assert.ok(p.user.includes("m365: seat exhausted"));
  assert.ok(p.user.includes("no seats left"));
  assert.ok(p.system.includes("READ-ONLY"));
  assert.ok(p.system.includes("propose_fix"));
  assert.ok(p.system.includes("no_fix"));
  assert.ok(p.system.includes("MINIMAL"));
});

test("checkEdit: exactly-once matching", () => {
  assert.deepEqual(checkEdit("a b c", "b"), { ok: true, count: 1 });
  assert.deepEqual(checkEdit("b a b", "b"), { ok: false, count: 2 });
  assert.deepEqual(checkEdit("a c", "b"), { ok: false, count: 0 });
  assert.deepEqual(checkEdit("aaa", ""), { ok: false, count: 0 });
});

test("applyEdit: replaces the single occurrence, leaves the rest", () => {
  assert.equal(applyEdit("const x = 1;\nconst y = 2;", { oldText: "const y = 2;", newText: "const y = 3;" }), "const x = 1;\nconst y = 3;");
});

test("validateProposalShape: catches missing pieces, passes a sane proposal", () => {
  const good = { diagnosis: "d", edits: [{ file: "web/a.ts", startLine: 1, endLine: 2, oldText: "old", newText: "new" }] };
  assert.equal(validateProposalShape(good), null);
  assert.ok(validateProposalShape({ diagnosis: "", edits: good.edits }));
  assert.ok(validateProposalShape({ diagnosis: "d", edits: [] }));
  assert.ok(validateProposalShape({ diagnosis: "d", edits: [{ ...good.edits[0], oldText: "" }] }));
  assert.ok(validateProposalShape({ diagnosis: "d", edits: [{ ...good.edits[0], newText: "old" }] })); // identical old/new
  assert.ok(validateProposalShape({ diagnosis: "d", edits: [{ ...good.edits[0], startLine: 0 }] }));
  assert.ok(validateProposalShape({ diagnosis: "d", edits: Array.from({ length: 13 }, () => ({ ...good.edits[0] })) }));
});

test("readPathProblem: repo-relative only; secrets/deps/VCS off-limits", () => {
  assert.equal(readPathProblem("web/lib/cases/repository.ts"), null);
  assert.equal(readPathProblem("runner/modules/Coretelligent.M365/Coretelligent.M365.psm1"), null);
  assert.ok(readPathProblem("/etc/passwd"));
  assert.ok(readPathProblem("../outside.txt"));
  assert.ok(readPathProblem("web/.env"));
  assert.ok(readPathProblem("web/.env.local"));
  assert.ok(readPathProblem("web/lib/secrets/vault.ts"));
  assert.ok(readPathProblem("web/node_modules/x/index.js"));
  assert.ok(readPathProblem(".git/config"));
});

test("maskKey: last 4 only", () => {
  assert.equal(maskKey("sk-ant-abcdefgh1234"), "…1234");
  assert.equal(maskKey("abc"), "••••");
  assert.equal(maskKey(undefined), "••••");
});

const PROVIDER_A = { name: "Claude", adapter: "anthropic", baseUrl: "https://api.anthropic.com/", model: "claude-sonnet-5", apiKey: "k-anthropic" };
const PROVIDER_O = { name: "OpenRouter", adapter: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", model: "meta/some-model", apiKey: "k-openai" };

test("adapterFor: picks by adapter string, throws on unknown", () => {
  assert.equal(adapterFor(PROVIDER_A), anthropicAdapter);
  assert.equal(adapterFor(PROVIDER_O), openAiAdapter);
  assert.throws(() => adapterFor({ adapter: "gemini-native" }));
});

test("anthropic adapter: url/headers/body wire format + response parsing", () => {
  assert.equal(anthropicAdapter.url(PROVIDER_A), "https://api.anthropic.com/v1/messages");
  assert.equal(anthropicAdapter.headers(PROVIDER_A)["x-api-key"], "k-anthropic");

  const convo = [
    { role: "user", text: "hi" },
    { role: "assistant", text: "looking", toolCalls: [{ id: "t1", name: "read_file", args: { path: "web/a.ts" } }] },
    { role: "tool_results", results: [{ id: "t1", name: "read_file", output: "1\tconst x = 1;" }] },
  ];
  const body = anthropicAdapter.body(PROVIDER_A, "sys", convo, FIX_TOOLS);
  assert.equal(body.model, "claude-sonnet-5");
  assert.equal(body.system, "sys");
  assert.equal(body.tools.length, FIX_TOOLS.length);
  assert.deepEqual(body.messages[1].content[1], { type: "tool_use", id: "t1", name: "read_file", input: { path: "web/a.ts" } });
  assert.deepEqual(body.messages[2].content[0], { type: "tool_result", tool_use_id: "t1", content: "1\tconst x = 1;" });

  const parsed = anthropicAdapter.parse({ content: [{ type: "text", text: "found it" }, { type: "tool_use", id: "t2", name: "propose_fix", input: { diagnosis: "d", edits: [] } }] });
  assert.equal(parsed.text, "found it");
  assert.deepEqual(parsed.toolCalls, [{ id: "t2", name: "propose_fix", args: { diagnosis: "d", edits: [] } }]);
});

test("openai adapter: url/headers/body wire format + response parsing (incl. malformed args)", () => {
  assert.equal(openAiAdapter.url(PROVIDER_O), "https://openrouter.ai/api/v1/chat/completions");
  const h = openAiAdapter.headers(PROVIDER_O);
  assert.equal(h.authorization, "Bearer k-openai");
  assert.equal(h["api-key"], "k-openai"); // Azure-compatible endpoint auth

  const convo = [
    { role: "user", text: "hi" },
    { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "search_repo", args: { pattern: "boom" } }] },
    { role: "tool_results", results: [{ id: "c1", name: "search_repo", output: "web/a.ts:3:boom" }] },
  ];
  const body = openAiAdapter.body(PROVIDER_O, "sys", convo, FIX_TOOLS);
  assert.deepEqual(body.messages[0], { role: "system", content: "sys" });
  assert.equal((body.messages[2] as unknown as { tool_calls: { function: { name: string } }[] }).tool_calls[0].function.name, "search_repo");
  assert.deepEqual(body.messages[3], { role: "tool", tool_call_id: "c1", content: "web/a.ts:3:boom" });
  assert.equal(body.tools[0].type, "function");

  const parsed = openAiAdapter.parse({ choices: [{ message: { content: null, tool_calls: [{ id: "c2", function: { name: "no_fix", arguments: '{"reason":"env"}' } }, { id: "c3", function: { name: "read_file", arguments: "{broken" } }] } }] });
  assert.deepEqual(parsed.toolCalls[0], { id: "c2", name: "no_fix", args: { reason: "env" } });
  assert.deepEqual(parsed.toolCalls[1].args, {}); // malformed JSON args → empty, not a crash
});
