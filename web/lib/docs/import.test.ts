import { test } from "node:test";
import assert from "node:assert/strict";
import { detectFormat, htmlToMarkdown, stripDownloadChrome, docxToMarkdown, importToMarkdown } from "./import";
import { markdownToDocxBuffer } from "./docx";
import type { VersionRow } from "./render";

test("detectFormat maps extensions and rejects the rest", () => {
  assert.equal(detectFormat("doc-v1.2.docx"), "docx");
  assert.equal(detectFormat("DOC.DOCX"), "docx");
  assert.equal(detectFormat("notes.md"), "md");
  assert.equal(detectFormat("notes.markdown"), "md");
  assert.equal(detectFormat("notes.txt"), "md");
  assert.equal(detectFormat("image.png"), null);
  assert.equal(detectFormat("nope.pdf"), null);
});

test("htmlToMarkdown converts headings, bold and GFM tables", () => {
  const md = htmlToMarkdown("<h1>Title</h1><p>Some <strong>bold</strong> text.</p><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>");
  assert.match(md, /^# Title/);
  assert.match(md, /\*\*bold\*\*/);
  assert.match(md, /\| A \| B \|/);
  assert.match(md, /\| 1 \| 2 \|/);
});

test("stripDownloadChrome removes the meta line, label and version-history table", () => {
  const input = [
    "# My Document",
    "",
    "Client-facing · Version 1.3",
    "",
    "**VERSION HISTORY**",
    "",
    "| Version | Date | By | What changed |",
    "| --- | --- | --- | --- |",
    "| 1.3 | 2026-07-15 | jane | tweak |",
    "| 1.2 | 2026-07-01 | jane | seed |",
    "",
    "## Overview",
    "",
    "Real body content here.",
  ].join("\n");
  const out = stripDownloadChrome(input);
  assert.match(out, /^# My Document/);
  assert.match(out, /## Overview/);
  assert.match(out, /Real body content here\./);
  assert.doesNotMatch(out, /Version 1\.3/);
  assert.doesNotMatch(out, /VERSION HISTORY/i);
  assert.doesNotMatch(out, /What changed/);
  assert.doesNotMatch(out, /2026-07-01/);
});

test("stripDownloadChrome keeps a real content table and a sentence mentioning a version", () => {
  const input = [
    "# Doc",
    "",
    "The connector was added in Version 2.0 of the runner.",
    "",
    "| System | Owner |",
    "| --- | --- |",
    "| M365 | cloud |",
  ].join("\n");
  const out = stripDownloadChrome(input);
  assert.match(out, /added in Version 2\.0 of the runner/); // sentence preserved
  assert.match(out, /\| System \| Owner \|/); // content table preserved
  assert.match(out, /\| M365 \| cloud \|/);
});

test("stripDownloadChrome does NOT drop a legitimate release-history table or a '· Version' content line", () => {
  const input = [
    "# Doc",
    "",
    "Adobe Sign · Version 2", // looks meta-ish but is real content — must survive
    "",
    "| Version | Date | By | Notes |", // a real body table, not the exact chrome header (Notes ≠ What changed)
    "| --- | --- | --- | --- |",
    "| 2.0 | 2026-01-01 | ops | GA |",
  ].join("\n");
  const out = stripDownloadChrome(input);
  assert.match(out, /Adobe Sign · Version 2/);
  assert.match(out, /\| Version \| Date \| By \| Notes \|/);
  assert.match(out, /\| 2\.0 \| 2026-01-01 \| ops \| GA \|/);
});

test("docx round-trip: our .docx download imports back to the same body, chrome stripped", async () => {
  const markdown = [
    "# Onboarding Runbook",
    "",
    "## Overview",
    "",
    "This runbook covers **new-user** onboarding.",
    "",
    "## Systems",
    "",
    "| System | Backbone |",
    "| --- | --- |",
    "| M365 | entra |",
    "| AD | ad-synced |",
    "",
    "## Steps",
    "",
    "- Create the account",
    "- Assign a license",
  ].join("\n");
  const rows: VersionRow[] = [
    { version: "1.1", date: "2026-07-15", changeNote: "update", author: "jane" },
    { version: "1.0", date: "2026-07-01", changeNote: "seed", author: "system" },
  ];
  const buf = await markdownToDocxBuffer({ title: "Onboarding Runbook", audienceLabel: "Client-facing", version: "1.1", markdown, versionRows: rows });
  const out = await docxToMarkdown(Buffer.from(buf));

  // Body survived the round-trip.
  assert.match(out, /# Onboarding Runbook/);
  assert.match(out, /## Overview/);
  assert.match(out, /new-user/);
  assert.match(out, /\| System \| Backbone \|/);
  assert.match(out, /M365/);
  assert.match(out, /Create the account/);
  // Injected chrome is gone.
  assert.doesNotMatch(out, /· *Version 1\.1/);
  assert.doesNotMatch(out, /VERSION HISTORY/i);
  assert.doesNotMatch(out, /What changed/);
});

test("importToMarkdown takes .md as-is and rejects unknown types", async () => {
  const { markdown, format } = await importToMarkdown("edited.md", Buffer.from("# Hi\n\nBody.", "utf8"));
  assert.equal(format, "md");
  assert.equal(markdown, "# Hi\n\nBody.");
  await assert.rejects(() => importToMarkdown("x.pdf", Buffer.from("x")), /unsupported file type/);
  await assert.rejects(() => importToMarkdown("blank.md", Buffer.from("   \n  ")), /no readable content/);
});
