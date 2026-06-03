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
import { azureConfigFromEnv, azureConfigured } from "../lib/generator/llm";
import { enrichProfile, applyEnrichment, enrichV21 } from "./generator/enrich";
import { applyV21Enrichment } from "../lib/generator/enrich-v21";

const prisma = new PrismaClient();
const OUT_DIR = join(process.cwd(), "..", "profiles", "generated");
const ENRICH = process.argv.includes("--enrich");
const V21 = process.argv.includes("--v21"); // extract v2.1 groups/attributes/personas/locations
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
    // only key real domains (must contain a dot) so a garbage roster primaryDomain like
    // "top" can't collide with every KB client's path-derived pseudo-domain.
    if (c.primaryDomain && c.primaryDomain.includes(".")) byDomain.set(c.primaryDomain.toLowerCase(), c);
    const nk = nameKey(c.name);
    if (nk) byName.set(nk, c);
  }

  const kbClients = loadClientKb(ENRICH || V21); // only retain runbook text when an LLM pass needs it
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
    v21: V21, v21Count: 0, v21Stats: { groups: 0, attributes: 0, personas: 0, locations: 0 },
    unmodeledHeaders: {} as Record<string, number>,
    clients: [] as Array<Record<string, unknown>>,
  };

  // Phase 1: build a candidate draft per KB client.
  type Cand = { kb: ClientKb; profile: DraftProfile; matched: RosterClient | null; confidence: "high" | "medium" | "low"; backboneConfident: boolean; systemKeys: string[] };
  const rank: Record<string, number> = { high: 3, medium: 2, low: 1 };
  const candidates: Cand[] = kbClients.map((kb) => {
    const dom = normalizeDomain(kb.domainRaw);
    const matched: RosterClient | null = (dom && byDomain.get(dom)) || byName.get(nameKey(kb.clientLeaf)) || null;
    const b = buildProfile(kb, matched);
    return { kb, matched, profile: b.profile, confidence: b.confidence, backboneConfident: b.backboneConfident, systemKeys: b.systemKeys };
  });

  // Phase 2: when several KB clients match the SAME roster client, keep only the richest
  // (most systems, then highest confidence) so the better draft wins at seed time instead
  // of a thin duplicate clobbering it. Unmatched candidates are all kept.
  const bestByRoster = new Map<string, Cand>();
  const kept: Cand[] = [];
  for (const c of candidates) {
    for (const u of c.kb.unmodeled) report.unmodeledHeaders[u] = (report.unmodeledHeaders[u] ?? 0) + 1; // full-corpus signal
    if (!c.matched) { kept.push(c); continue; }
    const prev = bestByRoster.get(c.matched.slug);
    const better = !prev
      || (c.systemKeys.length !== prev.systemKeys.length
        ? c.systemKeys.length > prev.systemKeys.length
        : rank[c.confidence] > rank[prev.confidence]);
    if (better) bestByRoster.set(c.matched.slug, c);
  }
  kept.push(...bestByRoster.values());

  // Phase 3: assign ids/filenames, build entries + report.
  for (const c of kept) {
    // client.id must equal the roster slug for matched clients so seed reconciles to it.
    const baseId = c.matched ? c.matched.slug : c.profile.client.id;
    c.profile.client.id = baseId;
    let fileSlug = baseId;
    if (usedSlugs.has(fileSlug)) fileSlug = `${fileSlug}-${slugify(c.kb.clientLeaf).slice(0, 6)}`;
    while (usedSlugs.has(fileSlug)) fileSlug = `${fileSlug}x`;
    usedSlugs.add(fileSlug);

    report[c.matched ? "matched" : "unmatched"]++;
    report.byConfidence[c.confidence]++;
    const entry: Record<string, unknown> = {
      slug: fileSlug, name: c.profile.client.name, matchedTo: c.matched?.slug ?? null,
      backbone: c.profile.identity.backbone, backboneConfident: c.backboneConfident, backboneSource: "heuristic",
      confidence: c.confidence, systems: c.systemKeys, systemCount: c.systemKeys.length,
      family: c.kb.family, unmodeled: c.kb.unmodeled.length,
    };
    report.clients.push(entry);
    entries.push({ kb: c.kb, profile: c.profile, matched: c.matched, slug: fileSlug, entry });
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

  // v2.1 extraction pass: pull the group/attribute/persona/location signal the heuristic dropped.
  if (V21) {
    const cfg = azureConfigFromEnv();
    if (!azureConfigured(cfg)) {
      console.warn("--v21 set but Azure OpenAI not configured (AZUREAI_BASE/AZUREAI_API); skipping.");
    } else {
      const targets = entries.filter((e) => ENRICH_ALL || e.matched);
      console.log(`v2.1 extraction on ${targets.length} profiles via ${cfg.deployment}…`);
      let done = 0;
      await pool(targets, CONCURRENCY, async (e) => {
        const v = await enrichV21(cfg, e.kb);
        if (v) {
          applyV21Enrichment(e.profile as never, v);
          report.v21Count++;
          report.v21Stats.groups += v.identityGroups.length;
          report.v21Stats.attributes += Object.keys(v.attributes).length;
          report.v21Stats.personas += v.personas.length;
          report.v21Stats.locations += v.locations.length;
          e.entry.schemaVersion = e.profile.schemaVersion;
          e.entry.v21 = { groups: v.identityGroups.length, attributes: Object.keys(v.attributes).length, personas: v.personas.length, locations: v.locations.length };
        }
        if (++done % 25 === 0) console.log(`  v2.1 extracted ${done}/${targets.length}`);
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
  if (V21) console.log(`  v2.1: ${report.v21Count} profiles gained signal — ${report.v21Stats.groups} groups, ${report.v21Stats.attributes} attributes, ${report.v21Stats.personas} personas, ${report.v21Stats.locations} locations`);
  console.log(`  backbones:`, report.backboneCounts);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
