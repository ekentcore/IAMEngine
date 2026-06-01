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
import type { IR } from "./ir.js";
import type { DraftMeta, Profile } from "./profile.js";

const TOOL_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

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

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const irDir = String(args.ir ?? join(TOOL_ROOT, "out", "ir"));
  const outDir = String(args.out ?? join(REPO_ROOT, "profiles", "_drafts"));
  const schemaPath = String(args.schema ?? join(REPO_ROOT, "profiles", "_schema.json"));
  const templatesDir = String(args.templates ?? join(TOOL_ROOT, "assemble", "templates"));
  const reportsDir = String(args.reports ?? join(TOOL_ROOT, "out", "reports"));
  const curatedDir = String(args.curated ?? join(REPO_ROOT, "profiles"));
  const reportOnly = Boolean(args["report-only"]);
  const doDiff = Boolean(args["diff-curated"]);

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
    if (validate(profile)) {
      metas.push(meta);
      generated.set(profile.client.name.toLowerCase(), profile);
      writeSteps(join(stepsDir, `${meta.id}.md`), ir, meta);
      if (!reportOnly) writeFileSync(join(outDir, `${meta.id}.json`), JSON.stringify(profile, null, 2) + "\n");
    } else {
      const errors = formatErrors(validate);
      invalid.push({ id: meta.id, errors });
      mkdirSync(invalidDir, { recursive: true });
      writeFileSync(join(invalidDir, `${meta.id}.json`), JSON.stringify({ profile, errors }, null, 2) + "\n");
    }
  }

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

type StepItem = { seq: number; auto: boolean; status: string; title: string; steps: string[] };

// Per-client step-by-step packet: EVERYTHING the runbook calls for, in document order,
// each tagged Automated vs Human interaction (manual or not-yet-modeled), with the runbook
// steps (username/password, fields, …) in collapsible <details>. The human-interaction
// items are the backlog for building new modules.
function writeSteps(path: string, ir: IR, meta: DraftMeta): void {
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
    const items: StepItem[] = [];
    for (const d of ir.detected.filter((x) => x.action === action)) {
      const auto = d.mode !== "manual";
      items.push({ seq: d.seq ?? 0, auto, status: auto ? "Automated" : "Human interaction (manual step)", title: `${d.systemKey} — ${d.section}`, steps: d.steps ?? [] });
    }
    for (const u of ir.unmodeled.filter((x) => x.action === action)) {
      items.push({ seq: u.seq ?? 0, auto: false, status: "Human interaction — not modeled (needs a module)", title: u.guess ? `${u.section} (${u.guess})` : u.section, steps: u.steps ?? [] });
    }
    if (items.length === 0) continue;
    items.sort((a, b) => a.seq - b.seq);
    const autoN = items.filter((i) => i.auto).length;
    lines.push("", `## ${action}`, "", `${items.length} steps — ${autoN} automated, ${items.length - autoN} human interaction`);
    for (const it of items) {
      const badge = it.auto ? "✅ Automated" : "✋ Human interaction";
      lines.push("", "<details>", `<summary><b>${badge}</b> · ${it.title}</summary>`, "", `_${it.status}_`, "");
      if (it.steps.length) {
        for (const s of it.steps) {
          const indent = s.match(/^ */)?.[0].length ?? 0;
          lines.push(`${" ".repeat(indent)}- ${s.trim()}`);
        }
      } else {
        lines.push("_(no step text captured — see the KB article)_");
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

process.exit(main());
