// Trace the EXACT app pipeline on a KB so we can see where the displayed runbook diverges from the
// KB text. Run:  npx tsx scripts/kb-trace.ts KB0017271
import { readFileSync } from "node:fs";

// Load web/.env into process.env (Next does this automatically; a standalone script doesn't).
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

async function main() {
const { fetchKbArticle } = await import("../lib/servicenow/kb");
const { snConfigFromEnv } = await import("../lib/servicenow/gateway");
const { redact } = await import("../lib/automation/redact");
const { parseRunbookText } = await import("../lib/clients/runbook-parse");
const { extractRunbookAI } = await import("../lib/clients/runbook-extract");
const { azureConfigFromEnv, azureConfigured } = await import("../lib/generator/llm");

const num = process.argv[2] || "KB0017271";
const sn = snConfigFromEnv();
const art = await fetchKbArticle({ instanceUrl: sn.instanceUrl, username: sn.username, password: sn.password } as never, num);
if (!art) { console.error("KB not found"); process.exit(1); }

const dash = (s: string) => console.log("\n" + "=".repeat(8) + " " + s + " " + "=".repeat(8));

dash("1) app's decoded KB text (fetchKbArticle)");
console.log(art.text);

dash("2) after redact() — what is actually sent to the AI");
const red = redact(art.text);
console.log(red);
console.log("\n[username line check]:", (red.match(/Username[^\n]*/i) || ["<none>"])[0]);
console.log("[license line check]:", (red.match(/Assign default licensing[^\n]*/i) || ["<none>"])[0]);

dash("3) heuristic parse (useAI OFF) — parseRunbookText");
for (const s of parseRunbookText(art.text)) {
  console.log(`\n## [${s.systemKey ?? "unmodeled"}] ${s.title}`);
  for (const st of s.steps) console.log("  - " + st);
}

dash("4) AI parse (useAI ON) — extractRunbookAI");
if (!azureConfigured(azureConfigFromEnv())) {
  console.log("Azure NOT configured in this env — the AI path returns null and the app falls back to the heuristic parse above.");
} else {
  const ai = await extractRunbookAI(art.text, "onboard");
  if (!ai) { console.log("extractRunbookAI returned null (Azure call failed) — app falls back to heuristic."); }
  else for (const s of ai) {
    console.log(`\n## [${s.systemKey ?? "unmodeled"}] ${s.title}`);
    for (const st of s.steps) console.log("  - " + st);
  }
}
}
main().catch((e) => { console.error(e); process.exit(1); });
