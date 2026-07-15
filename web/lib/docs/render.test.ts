import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownToHtml, sanitizeHtml, versionTableHtml, styledHtmlDocument } from "./render";
import { markdownToDocxBuffer } from "./docx";

test("markdownToHtml renders headings and GFM tables", () => {
  const html = markdownToHtml("# Title\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n");
  assert.match(html, /<h1[^>]*>Title<\/h1>/);
  assert.match(html, /<table>/);
  assert.match(html, /<th>A<\/th>/);
  assert.match(html, /<td>1<\/td>/);
});

test("sanitizeHtml strips script tags and inline handlers", () => {
  const out = sanitizeHtml('<p onclick="x()">hi</p><script>alert(1)</script>');
  assert.ok(!/script/i.test(out));
  assert.ok(!/onclick/i.test(out));
  assert.match(out, /<p>hi<\/p>/);
});

test("versionTableHtml renders a row per version", () => {
  const html = versionTableHtml([{ version: "1.1", date: "2026-07-15", changeNote: "x", author: "a@b" }]);
  assert.match(html, /1\.1/);
  assert.match(html, /2026-07-15/);
});

test("styledHtmlDocument is a self-contained page with inline style and no external requests", () => {
  const html = styledHtmlDocument({ title: "Doc", audienceLabel: "Client-facing", version: "1.0", bodyHtml: "<p>body</p>", versionRows: [] });
  assert.match(html, /<!doctype html>/);
  assert.match(html, /<style>/);
  assert.ok(!/https?:\/\//.test(html.replace(/xmlns="[^"]*"/g, "")), "no external URLs");
});

test("markdownToDocxBuffer produces a non-trivial .docx buffer for markdown with a table", async () => {
  const md = "# Title\n\nSome **bold** text.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n- one\n- two\n";
  const buf = await markdownToDocxBuffer({ title: "Doc", audienceLabel: "Client-facing", version: "1.0", markdown: md, versionRows: [{ version: "1.0", date: "2026-07-14", changeNote: "Initial version.", author: "Seed" }] });
  assert.ok(Buffer.isBuffer(buf));
  assert.ok(buf.length > 1000, "a real docx zip is well over 1KB");
  // .docx is a zip — first bytes are the PK signature.
  assert.equal(buf[0], 0x50);
  assert.equal(buf[1], 0x4b);
});
