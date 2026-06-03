// Dump the v2.1 candidate clients: heuristic signal (role/location/group) cross-referenced with
// what the LLM extractor actually pulls (groups / attributes / personas / locations). The point is
// to see which clients GENUINELY need personas (role-conditional config) vs. which just have a flat
// group + attribute map (the common case). Writes a ranked markdown table to profiles/generated/.
// Usage: npx tsx scripts/dump-v21-candidates.ts [minScore=2] [--no-llm]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadClientKb, type ClientKb } from "./generator/kb";
import { azureConfigFromEnv, azureConfigured } from "../lib/generator/llm";
import { enrichV21 } from "./generator/enrich";
import type { V21Enrichment } from "../lib/generator/enrich-v21";

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

// Same heuristic signals as audit-kb-21-signal.mjs, over the stripped runbook text.
const ROLE_RE = /\b(if (the )?(user|employee|they) (is|are|will be)|depending on (the|their)|based on (their |the )?(role|title|department|position|job)|for (sales|engineering|finance|hr|executive|admin|management|field|remote|professional)\b|persona|job role|by (role|title|department))\b/i;
const LOC_RE = /\b(time ?zone|office location|site code|by (office|location|site)|each (office|location|site)|branch office|physical(deliveryofficename)?|street address|city.{0,12}state)\b/i;
const GROUP_RE = /\b(security group|distribution (list|group)|add(ed)? to (the )?group|member ?of|group membership|ad groups?|m365 groups?|microsoft 365 groups?)\b/i;

function signal(kb: ClientKb) {
  const t = `${kb.onboardText}\n${kb.offboardText}`.toLowerCase();
  const role = ROLE_RE.test(t), loc = LOC_RE.test(t), grp = GROUP_RE.test(t);
  return { role, loc, grp, score: (role ? 1 : 0) + (loc ? 1 : 0) + (grp ? 1 : 0) };
}

async function pool<T>(items: T[], n: number, fn: (item: T, i: number) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  }));
}

async function main() {
  loadRootEnv();
  const minScore = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 2);
  const useLlm = !process.argv.includes("--no-llm");
  const cfg = azureConfigFromEnv();
  const llmOk = useLlm && azureConfigured(cfg);

  const kbs = loadClientKb(true);
  const candidates = kbs
    .map((kb) => ({ kb, sig: signal(kb) }))
    .filter((c) => c.sig.score >= minScore)
    .sort((a, b) => b.sig.score - a.sig.score);

  console.log(`${candidates.length} clients with >=${minScore} signals${llmOk ? `; running v2.1 extraction via ${cfg.deployment}…` : " (heuristic only)"}\n`);

  type Row = { client: string; kb: string | null; sig: ReturnType<typeof signal>; v: V21Enrichment | null };
  const rows: Row[] = candidates.map((c) => ({ client: c.kb.clientLeaf, kb: c.kb.onboardKb, sig: c.sig, v: null }));
  if (llmOk) {
    let done = 0;
    await pool(candidates, 6, async (c, i) => {
      rows[i].v = await enrichV21(cfg, c.kb);
      if (++done % 10 === 0) console.log(`  extracted ${done}/${candidates.length}`);
    });
  }

  // Rank: needs-personas first (LLM found roles), then by extracted richness, then heuristic score.
  rows.sort((a, b) =>
    (b.v?.personas.length ?? 0) - (a.v?.personas.length ?? 0)
    || richness(b.v) - richness(a.v)
    || b.sig.score - a.sig.score
    || a.client.localeCompare(b.client));

  const lines: string[] = [];
  lines.push(`# v2.1 candidate clients (>=${minScore} heuristic signals)`);
  lines.push("");
  lines.push(`Generated over ${kbs.length} KB clients; ${candidates.length} candidates. ` +
    (llmOk ? "LLM columns = what the v2.1 extractor actually pulled." : "Heuristic only (no LLM)."));
  lines.push("");
  lines.push("Legend: signal = role/loc/grp heuristic hits. **Personas>0 = genuinely role-based** (the rest are flat group+attribute clients).");
  lines.push("");
  lines.push("| # | Client | signal | groups | attrs | **personas** | locations | persona names |");
  lines.push("|---|--------|--------|--------|-------|--------------|-----------|---------------|");
  rows.forEach((r, i) => {
    const s = `${r.sig.role ? "R" : "·"}${r.sig.loc ? "L" : "·"}${r.sig.grp ? "G" : "·"}`;
    const v = r.v;
    const names = v?.personas.map((p) => p.name).join(", ") ?? "";
    lines.push(`| ${i + 1} | ${r.client} | ${s} | ${v?.identityGroups.length ?? "—"} | ${Object.keys(v?.attributes ?? {}).length || "—"} | ${v?.personas.length ?? "—"} | ${v?.locations.length ?? "—"} | ${names} |`);
  });

  const withPersonas = rows.filter((r) => (r.v?.personas.length ?? 0) > 0);
  lines.push("");
  lines.push(`## Summary`);
  lines.push(`- Candidates: **${candidates.length}**`);
  if (llmOk) {
    lines.push(`- Genuinely role-based (personas extracted): **${withPersonas.length}** — ${withPersonas.map((r) => r.client).join("; ") || "none"}`);
    lines.push(`- Flat group+attribute clients (no personas): **${rows.length - withPersonas.length}**`);
    lines.push(`- Total extracted: ${sum(rows, (r) => r.v?.identityGroups.length ?? 0)} groups, ${sum(rows, (r) => Object.keys(r.v?.attributes ?? {}).length)} attributes, ${sum(rows, (r) => r.v?.locations.length ?? 0)} locations.`);
  }

  const out = join(process.cwd(), "..", "profiles", "generated", "_v21-candidates.md");
  writeFileSync(out, lines.join("\n"));
  console.log(`\n${lines.slice(lines.indexOf("## Summary")).join("\n")}`);
  console.log(`\nWrote ${out}`);
}

const richness = (v: V21Enrichment | null) => (v ? v.identityGroups.length + Object.keys(v.attributes).length + v.locations.length : 0);
const sum = <T>(a: T[], f: (x: T) => number) => a.reduce((n, x) => n + f(x), 0);

main().catch((e) => { console.error(e); process.exit(1); });
