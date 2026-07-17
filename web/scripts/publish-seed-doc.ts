/* Publish a seed document's Markdown as a new version, when the seed file has moved ahead of the DB.
 *
 *   npx tsx scripts/publish-seed-doc.ts --slug setup-and-configuration            # show the diff
 *   npx tsx scripts/publish-seed-doc.ts --slug setup-and-configuration --publish \
 *     --note "Add the Graph permissions asked for in PR #103."
 *
 * Why this is needed: prisma/seed-docs.ts only creates a version when a document has NONE, so that
 * re-seeding can never clobber an AI update or a hand edit. Correct — but it means editing a file in
 * prisma/seed-docs/ changes NOTHING that a reader sees. /docs serves the DB. That is how the M365
 * password-reset permission came to be documented in the repo and absent from the guide we hand to
 * clients: the file said one thing and the published document said another for a day.
 *
 * Publishing goes through lib/docs/store.ts (createDraft → publishDraft) rather than writing rows
 * directly, so the version number, provenance and change note are stamped exactly as the UI stamps
 * them, and a version published this way is indistinguishable from one published by an operator.
 *
 * Refuses to publish when the DB is AHEAD of or divergent from the seed file — see --force.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "@/lib/db";
import { latestPublished, pendingDraft, createDraft, publishDraft } from "@/lib/docs/store";
import { diffLines } from "@/lib/docs/diff";

// What this script stamps on a version it publishes — and, on the way back in, one of the two labels
// that mean "the seed file is still authoritative for this document".
const SYNC_LABEL = "Seed sync";

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const slug = flag("--slug");
const note = flag("--note");
const publish = argv.includes("--publish");
const force = argv.includes("--force");

// What a publish would change — through the SAME diff /docs renders its redline with. A second
// implementation here would be a preview that disagrees with the review screen about the very edit
// being approved, and the obvious set-based shortcut is genuinely worse: identical lines appearing
// twice (blank lines, repeated table rows) collapse, so it under-reports real changes.
function lineDiff(before: string, after: string): { added: string[]; removed: string[] } {
  const d = diffLines(before, after);
  return {
    added: d.filter((l) => l.type === "add" && l.text.trim()).map((l) => l.text),
    removed: d.filter((l) => l.type === "del" && l.text.trim()).map((l) => l.text),
  };
}

(async () => {
  if (!slug) throw new Error("--slug is required (e.g. --slug setup-and-configuration)");
  const seedPath = resolve(__dirname, "..", "prisma", "seed-docs", `${slug}.md`);
  const seed = readFileSync(seedPath, "utf8");

  const doc = await db.document.findUnique({ where: { slug }, include: { versions: true } });
  if (!doc) throw new Error(`no document with slug "${slug}"`);
  const current = latestPublished(doc.versions);
  if (!current) throw new Error(`"${slug}" has no published version — run the seed first`);

  const draft = pendingDraft(doc.versions);
  if (draft) throw new Error(`"${slug}" already has a pending draft (v${draft.version}) — publish or discard it in /docs first`);

  if (current.markdown === seed) {
    console.log(`"${slug}" v${current.version} already matches ${seedPath} — nothing to publish.`);
    await db.$disconnect();
    return;
  }

  const { added, removed } = lineDiff(current.markdown, seed);
  console.log(`"${slug}" — published v${current.version} (${current.markdown.length} chars) vs the seed file (${seed.length} chars)\n`);
  for (const l of removed) console.log(`  - ${l.slice(0, 160)}`);
  for (const l of added) console.log(`  + ${l.slice(0, 160)}`);
  console.log(`\n${added.length} line(s) added, ${removed.length} removed.`);

  // The seed file is only the source of truth for a document nobody has edited in the app. Publishing
  // it over an operator's edit or an AI update would silently revert them.
  //
  // The test for that is PROVENANCE, not the diff above: a rewritten table row shows up as a removed
  // line plus an added one, so "lines vanished" flags every ordinary edit while a pure append by an
  // operator would slip through. Who made the current version answers the question exactly — if the
  // seed pipeline made it, nobody has edited it, whatever the lines look like.
  const seedMade = !current.generatedByAi && (current.createdByLabel === "Seed" || current.createdByLabel === SYNC_LABEL);
  if (!seedMade && !force) {
    console.error(`\nREFUSING to publish: v${current.version} was published by "${current.createdByLabel ?? "unknown"}"${current.generatedByAi ? " (an AI update)" : ""}, not by the seed.`);
    console.error(`Publishing ${seedPath} over it would revert that work. Reconcile the file with the published`);
    console.error(`document first, or pass --force if the revert is intended.`);
    await db.$disconnect();
    process.exit(1);
  }

  if (!publish) {
    console.log(`\nNothing published. Re-run with --publish --note "<what changed>" to publish as v${Number(current.version.split(".")[0])}.${Number(current.version.split(".")[1]) + 1}.`);
    await db.$disconnect();
    return;
  }
  if (!note) throw new Error('--note "<what changed>" is required when publishing — it is what the version table shows');

  const d = await createDraft({
    documentId: doc.id,
    markdown: seed,
    changeNote: note,
    changelogThrough: current.changelogThrough ?? null,
    createdById: null,
    createdByLabel: SYNC_LABEL,
    generatedByAi: false, // a file the repo already reviewed, not a model's draft
  });
  if (d.error || !d.draft) throw new Error(d.error ?? "could not create the draft");
  const p = await publishDraft(d.draft.id, "minor", SYNC_LABEL, null);
  if (p.error || !p.version) throw new Error(p.error ?? "could not publish the draft");
  console.log(`\npublished "${slug}" v${p.version.version}.`);
  await db.$disconnect();
})().catch(async (e) => { console.error(e instanceof Error ? e.message : e); await db.$disconnect(); process.exit(1); });
