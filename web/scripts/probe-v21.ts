// Live probe: run the v2.1 extraction against a few named clients and print the result.
// Usage: npx tsx scripts/probe-v21.ts "Apollon" "Six One" "Carrington"
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadClientKb } from "./generator/kb";
import { azureConfigFromEnv, azureConfigured } from "../lib/generator/llm";
import { enrichV21 } from "./generator/enrich";

function loadRootEnv() {
  const path = join(process.cwd(), "..", "env.env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith("@")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    const k = t.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || process.env[k]) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[k] = v;
  }
}

async function main() {
  loadRootEnv();
  const cfg = azureConfigFromEnv();
  console.log(`Azure configured: ${azureConfigured(cfg)}  (deployment=${cfg.deployment}, endpoint=${cfg.endpoint ? "set" : "MISSING"})`);
  if (!azureConfigured(cfg)) process.exit(1);

  const needles = (process.argv.slice(2).length ? process.argv.slice(2) : ["Apollon", "Six One", "Carrington"]).map((s) => s.toLowerCase());
  const kbs = loadClientKb(true).filter((k) => needles.some((n) => k.clientLeaf.toLowerCase().includes(n)));
  console.log(`Matched ${kbs.length} client(s): ${kbs.map((k) => k.clientLeaf).join(" | ")}\n`);

  for (const kb of kbs) {
    console.log("=".repeat(70));
    console.log(`CLIENT: ${kb.clientLeaf}  (onboard KB ${kb.onboardKb})`);
    const v = await enrichV21(cfg, kb);
    if (!v) { console.log("  → no v2.1 signal extracted (stays v2.0)\n"); continue; }
    console.log(`  identityGroups (${v.identityGroups.length}): ${v.identityGroups.join(", ") || "—"}`);
    console.log(`  attributes: ${JSON.stringify(v.attributes)}`);
    console.log(`  usernamePattern: ${v.usernamePattern ?? "—"}`);
    console.log(`  personas (${v.personas.length}):`);
    for (const p of v.personas) console.log(`     - ${p.name} | titles=[${p.titles.join(", ")}] groups=[${p.groups.join(", ")}] ou=${p.ou ?? "—"}`);
    console.log(`  locations (${v.locations.length}):`);
    for (const l of v.locations) console.log(`     - ${l.name} | ${l.city ?? ""} ${l.state ?? ""} ${l.timezone ?? ""} ${l.country?.short ?? ""}`.trimEnd());
    console.log();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
