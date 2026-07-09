// Assembly stage CLI: IR (*.ir.json) -> validated v2 profiles in profiles/_drafts/ + a
// review report. The schema is a hard gate: invalid drafts are diverted and the process
// exits non-zero.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assembleProfile } from "./assemble.js";
import { applyTemplate } from "./templates.js";
import { makeValidator, formatErrors } from "./validate.js";
import { diffAgainstCurated } from "./diff.js";
import { buildRunbook, runbookTitle, type RunbookItem } from "./runbook.js";
import { azureConfigFromEnv, azureConfigured } from "./llm.js";
import { enrichV21, applyV21Enrichment } from "./enrich-v21.js";
import type { IR } from "./ir.js";
import type { DraftMeta, Profile } from "./profile.js";

const TOOL_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

// Load REPO_ROOT/env.env into process.env (for AZUREAI_*) without overriding existing vars.
function loadRootEnv(): void {
  const path = join(REPO_ROOT, "env.env");
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

async function pool<T>(items: T[], n: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  }));
}

interface Args { [k: string]: string | boolean }
function parseArgs(argv: string[]): Args {
  const a: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--")) {
      const key = t.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) { a[key] = next; i++; } else { a[key] = true; }
    }
  }
  return a;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const irDir = String(args.ir ?? join(TOOL_ROOT, "out", "ir"));
  const outDir = String(args.out ?? join(REPO_ROOT, "profiles", "_drafts"));
  const schemaPath = String(args.schema ?? join(REPO_ROOT, "profiles", "_schema.json"));
  const templatesDir = String(args.templates ?? join(TOOL_ROOT, "assemble", "templates"));
  const reportsDir = String(args.reports ?? join(TOOL_ROOT, "out", "reports"));
  const curatedDir = String(args.curated ?? join(REPO_ROOT, "profiles"));
  const reportOnly = Boolean(args["report-only"]);
  const doDiff = Boolean(args["diff-curated"]);
  const v21 = Boolean(args.v21); // opt-in LLM pass: extract groups/attributes/personas/locations

  if (!existsSync(irDir)) { console.error(`No IR dir: ${irDir} (run the extract stage first)`); return 2; }
  const irFiles = readdirSync(irDir).filter((f) => f.endsWith(".ir.json"));
  if (!irFiles.length) { console.error(`No *.ir.json in ${irDir}`); return 2; }

  const validate = makeValidator(schemaPath);
  const metas: DraftMeta[] = [];
  const generated = new Map<string, Profile>();
  const invalid: { id: string; errors: string[] }[] = [];
  const needsManual: { id: string; name: string; unmodeled: number }[] = [];

  if (!reportOnly) { mkdirSync(outDir, { recursive: true }); }
  mkdirSync(reportsDir, { recursive: true });
  const invalidDir = join(reportsDir, "invalid");
  const stepsDir = join(reportsDir, "steps");
  mkdirSync(stepsDir, { recursive: true });

  // Phase 1: assemble every IR into a profile (deterministic). Diverted cases (unreadable IR,
  // no modeled systems) are recorded now; the rest become candidates for optional enrichment.
  const candidates: { ir: IR; profile: Profile; meta: DraftMeta }[] = [];
  for (const f of irFiles) {
    let ir: IR;
    try {
      ir = JSON.parse(readFileSync(join(irDir, f), "utf8")) as IR;
    } catch (e) {
      // one corrupt IR file must not abort the whole fleet run
      invalid.push({ id: f, errors: [`unreadable IR: ${(e as Error).message}`] });
      continue;
    }
    let { profile, meta } = assembleProfile(ir);
    profile = applyTemplate(profile, ir.client.family ?? null, templatesDir);
    if (profile.systems.length === 0) {
      // No modeled systems detected (sparse/free-form runbook) — not a generator failure;
      // flag for manual profiling rather than emit a meaningless empty profile.
      needsManual.push({ id: meta.id, name: meta.name, unmodeled: ir.unmodeled.length });
      continue;
    }
    candidates.push({ ir, profile, meta });
  }

  // Phase 2 (optional): LLM v2.1 enrichment — fold recovered groups/attributes/personas/
  // locations into each profile (bumping it to schemaVersion 2.1) BEFORE the schema gate.
  let v21Count = 0;
  if (v21) {
    loadRootEnv();
    const cfg = azureConfigFromEnv();
    if (!azureConfigured(cfg)) {
      console.warn("--v21 set but Azure OpenAI not configured (AZUREAI_BASE/AZUREAI_API); skipping enrichment.");
    } else {
      console.log(`v2.1 enrichment on ${candidates.length} drafts via ${cfg.deployment}…`);
      let done = 0;
      await pool(candidates, 6, async (c) => {
        const e = await enrichV21(cfg, c.ir);
        if (e) { applyV21Enrichment(c.profile, e); v21Count++; }
        if (++done % 25 === 0) console.log(`  enriched ${done}/${candidates.length}`);
      });
    }
  }

  // Phase 3: schema gate + write (profile + companion runbook).
  for (const { ir, profile, meta } of candidates) {
    if (validate(profile)) {
      metas.push(meta);
      generated.set(profile.client.name.toLowerCase(), profile);
      const runbook = buildRunbook(ir);
      writeSteps(join(stepsDir, `${meta.id}.md`), runbook, ir, meta);
      if (!reportOnly) {
        writeFileSync(join(outDir, `${meta.id}.json`), JSON.stringify(profile, null, 2) + "\n");
        // companion runbook (modeled + unmodeled + steps) seed loads into RunbookSection
        writeFileSync(join(outDir, `${meta.id}.runbook.json`), JSON.stringify(runbook, null, 2) + "\n");
      }
    } else {
      const errors = formatErrors(validate);
      invalid.push({ id: meta.id, errors });
      mkdirSync(invalidDir, { recursive: true });
      writeFileSync(join(invalidDir, `${meta.id}.json`), JSON.stringify({ profile, errors }, null, 2) + "\n");
    }
  }
  if (v21) console.log(`  v2.1: ${v21Count}/${candidates.length} drafts gained signal`);

  writeReport(join(reportsDir, "drafts.md"), metas, invalid, needsManual, doDiff ? diffAgainstCurated(curatedDir, generated) : []);

  const bands = { high: 0, medium: 0, low: 0 } as Record<string, number>;
  metas.forEach((m) => bands[m.band]++);
  console.log(`Assembled ${metas.length} valid drafts` + (reportOnly ? " (report-only)" : ` -> ${outDir}`));
  console.log(`  confidence bands: ${JSON.stringify(bands)}`);
  if (needsManual.length) console.log(`  needs manual profiling (no modeled systems): ${needsManual.length}`);
  if (invalid.length) console.log(`  INVALID (schema gate): ${invalid.length} -> ${invalidDir}`);
  console.log(`  report: ${join(reportsDir, "drafts.md")}`);
  console.log(`  per-client steps: ${stepsDir}/<id>.md`);
  return invalid.length ? 1 : 0;
}

// Per-client step-by-step packet: EVERYTHING the runbook calls for, in document order,
// each tagged Automated vs Human interaction (manual or not-yet-modeled), with the runbook
// steps (username/password, fields, …) in collapsible <details>. The human-interaction
// items are the backlog for building new modules.
function writeSteps(path: string, all: RunbookItem[], ir: IR, meta: DraftMeta): void {
  const lines = [
    `# ${meta.name} — onboarding & offboarding steps`,
    "",
    `backbone: ${meta.backbone}${meta.backboneDefaulted ? " (default — verify)" : ""} · confidence ${meta.confidence} · KB ${ir.kb.onboard ?? "–"} / ${ir.kb.offboard ?? "–"}`,
    "",
    "Everything the runbook calls for, in order. **✅ Automated** runs via a module; "
    + "**✋ Human interaction** (manual or not-yet-modeled) needs a person — those are the "
    + "candidates for new modules. Expand each to see the steps. Text is from the KB; open the "
    + "article for anything truncated.",
  ];
  for (const action of ["onboarding", "offboarding"] as const) {
    const items = all.filter((i) => i.action === action);
    if (items.length === 0) continue;
    const autoN = items.filter((i) => i.status === "automated").length;
    lines.push("", `## ${action}`, "", `${items.length} steps — ${autoN} automated, ${items.length - autoN} human interaction`);
    for (const it of items) {
      const badge = it.status === "automated" ? "✅ Automated" : "✋ Human interaction";
      const sub = it.status === "automated" ? "Automated" : it.status === "manual" ? "Human interaction (manual step)" : "Human interaction — not modeled (needs a module)";
      lines.push("", "<details>", `<summary><b>${badge}</b> · ${runbookTitle(it)}</summary>`, "", `_${sub}_`, "");
      if (it.steps.length) {
        for (const s of it.steps) {
          const indent = s.match(/^ */)?.[0].length ?? 0;
          lines.push(`${" ".repeat(indent)}- ${s.trim()}`);
        }
      } else if (!it.artifacts.length) {
        lines.push("_(no step text captured — see the KB article)_");
      }
      for (const a of it.artifacts) {
        if (a.type === "email") {
          lines.push("", "**✉ Email template** (placeholders filled from the UM case later):", "", "```");
          if (a.to.length) lines.push(`To: ${a.to.join(", ")}`);
          if (a.cc?.length) lines.push(`Cc: ${a.cc.join(", ")}`);
          lines.push(`Subject: ${a.subject}`, "", a.body, "```");
        }
      }
      lines.push("", "</details>");
    }
  }
  writeFileSync(path, lines.join("\n") + "\n");
}

function writeReport(path: string, metas: DraftMeta[], invalid: { id: string; errors: string[] }[], needsManual: { id: string; name: string; unmodeled: number }[], diffLines: string[]): void {
  const rows = [...metas].sort((a, b) => a.confidence - b.confidence); // worst first for review
  const lines = [
    "# Draft profiles — review report",
    "",
    `${metas.length} valid drafts, ${invalid.length} invalid. Lowest-confidence first — review these before promoting out of profiles/_drafts/.`,
    "",
    "Per-client runbook steps (incl. unmodeled sections) are in `steps/<id>.md`.",
    "",
    "| conf | band | client | backbone | systems | unmodeled systems (detected, not modeled) | warnings |",
    "|---:|---|---|---|---:|---|---:|",
  ];
  for (const m of rows) {
    const bb = m.backbone + (m.backboneDefaulted ? " *(default)*" : "");
    const unm = m.unmodeled.length ? m.unmodeled.slice(0, 5).join(", ") + (m.unmodeled.length > 5 ? ` +${m.unmodeled.length - 5}` : "") : "—";
    lines.push(`| ${m.confidence.toFixed(2)} | ${m.band} | ${m.name} | ${bb} | ${m.systemCount} | ${unm} | ${m.warnings.length} |`);
  }
  if (needsManual.length) {
    lines.push("", "## Needs manual profiling — no modeled systems detected", "",
      "These clients' runbooks had no recognisable system sections (sparse / free-form / "
      + "placeholder docs). Profile them by hand.", "");
    for (const n of needsManual.sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`- **${n.name}** (${n.id}) — ${n.unmodeled} unmodeled section(s)`);
    }
  }
  if (invalid.length) {
    lines.push("", "## Invalid drafts (failed schema gate — generator bug)", "");
    for (const v of invalid) lines.push(`- **${v.id}**: ${v.errors.slice(0, 3).join("; ")}`);
  }
  lines.push(...diffLines);
  writeFileSync(path, lines.join("\n") + "\n");
}

main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
