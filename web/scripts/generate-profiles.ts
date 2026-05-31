// KB -> draft profile generator (Phase 3, hybrid).
// Heuristic core: data/*.jsonl -> detected systems + inferred backbone -> draft v2 profile,
// matched to the synced roster, written to profiles/generated/<slug>.json + _report.json.
// Optional `--enrich`: an Azure OpenAI pass that corrects backbone + adds light config.
// Run: npm run generate:profiles   (add -- --enrich to enable the LLM pass)
import { PrismaClient } from "@prisma/client";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadClientKb, type ClientKb } from "./generator/kb";
import { buildProfile, slugify, normalizeDomain, type DraftProfile } from "./generator/build";
import { azureConfigFromEnv, azureConfigured } from "./generator/llm";
import { enrichProfile, applyEnrichment } from "./generator/enrich";

const prisma = new PrismaClient();
const OUT_DIR = join(process.cwd(), "..", "profiles", "generated");
const ENRICH = process.argv.includes("--enrich");
const ENRICH_ALL = process.argv.includes("--all");
const CONCURRENCY = 6;

// Load root env.env into process.env (for AZURE_OPENAI_* and DATABASE_URL) without overriding.
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

function nameKey(name: string): string {
  return name
    .toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(llc|inc|lp|llp|ltd|co|corp|corporation|company|holdings|partners|capital|group|the)\b/g, " ")
    .replace(/\s+/g, " ").trim();
}

type RosterClient = { slug: string; name: string; primaryDomain: string };

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        await fn(items[idx]);
      }
    })
  );
}

async function main() {
  loadRootEnv();

  const roster = await prisma.client.findMany({ select: { slug: true, name: true, primaryDomain: true } });
  const byDomain = new Map<string, RosterClient>();
  const byName = new Map<string, RosterClient>();
  for (const c of roster) {
    if (c.primaryDomain) byDomain.set(c.primaryDomain.toLowerCase(), c);
    const nk = nameKey(c.name);
    if (nk) byName.set(nk, c);
  }

  const kbClients = loadClientKb();
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const usedSlugs = new Set<string>();
  type Entry = { kb: ClientKb; profile: DraftProfile; matched: RosterClient | null; slug: string; entry: Record<string, unknown> };
  const entries: Entry[] = [];
  const report = {
    generatedAt: new Date().toISOString(), enriched: ENRICH,
    kbClients: kbClients.length, matched: 0, unmatched: 0,
    byConfidence: { high: 0, medium: 0, low: 0 } as Record<string, number>,
    backboneCounts: {} as Record<string, number>,
    enrichedCount: 0, backboneChanged: 0,
    unmodeledHeaders: {} as Record<string, number>,
    clients: [] as Array<Record<string, unknown>>,
  };

  for (const kb of kbClients) {
    const dom = normalizeDomain(kb.domainRaw);
    const matched: RosterClient | null = (dom && byDomain.get(dom)) || byName.get(nameKey(kb.clientLeaf)) || null;
    const { profile, confidence, backboneConfident, systemKeys } = buildProfile(kb, matched);

    let slug = profile.client.id;
    if (usedSlugs.has(slug)) slug = `${slug}-${slugify(kb.clientLeaf).slice(0, 6)}`;
    while (usedSlugs.has(slug)) slug = `${slug}x`;
    usedSlugs.add(slug);
    profile.client.id = slug;

    report[matched ? "matched" : "unmatched"]++;
    report.byConfidence[confidence]++;
    for (const u of kb.unmodeled) report.unmodeledHeaders[u] = (report.unmodeledHeaders[u] ?? 0) + 1;

    const entry: Record<string, unknown> = {
      slug, name: profile.client.name, matchedTo: matched?.slug ?? null,
      backbone: profile.identity.backbone, backboneConfident, backboneSource: "heuristic",
      confidence, systems: systemKeys, systemCount: systemKeys.length,
      family: kb.family, unmodeled: kb.unmodeled.length,
    };
    report.clients.push(entry);
    entries.push({ kb, profile, matched, slug, entry });
  }

  // Optional LLM enrichment pass (matched clients by default; --all for everyone).
  if (ENRICH) {
    const cfg = azureConfigFromEnv();
    if (!azureConfigured(cfg)) {
      console.warn("--enrich set but AZURE_OPENAI_* not configured; skipping enrichment.");
    } else {
      const targets = entries.filter((e) => ENRICH_ALL || e.matched);
      console.log(`Enriching ${targets.length} profiles via ${cfg.deployment}…`);
      let done = 0;
      await pool(targets, CONCURRENCY, async (e) => {
        const enr = await enrichProfile(cfg, e.kb);
        if (enr) {
          const before = e.profile.identity.backbone;
          applyEnrichment(e.profile, enr);
          report.enrichedCount++;
          if (before !== e.profile.identity.backbone) report.backboneChanged++;
          e.entry.backbone = e.profile.identity.backbone;
          e.entry.backboneSource = "llm";
          e.entry.backboneConfidence = enr.backboneConfidence;
          e.entry.backboneReason = enr.reason;
        }
        if (++done % 25 === 0) console.log(`  enriched ${done}/${targets.length}`);
      });
    }
  }

  // Write all profiles (post-enrichment) + tally backbones.
  for (const e of entries) {
    writeFileSync(join(OUT_DIR, `${e.slug}.json`), JSON.stringify(e.profile, null, 2));
    const bb = String(e.profile.identity.backbone);
    report.backboneCounts[bb] = (report.backboneCounts[bb] ?? 0) + 1;
  }

  report.unmodeledHeaders = Object.entries(report.unmodeledHeaders)
    .sort((a, b) => b[1] - a[1])
    .reduce<Record<string, number>>((o, [k, v]) => ((o[k] = v), o), {});
  writeFileSync(join(OUT_DIR, "_report.json"), JSON.stringify(report, null, 2));

  console.log(`\nGenerated ${kbClients.length} draft profiles -> profiles/generated/`);
  console.log(`  matched to roster: ${report.matched}   unmatched: ${report.unmatched}`);
  console.log(`  confidence: ${report.byConfidence.high} high / ${report.byConfidence.medium} medium / ${report.byConfidence.low} low`);
  if (ENRICH) console.log(`  enriched: ${report.enrichedCount}   backbone changed by LLM: ${report.backboneChanged}`);
  console.log(`  backbones:`, report.backboneCounts);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
