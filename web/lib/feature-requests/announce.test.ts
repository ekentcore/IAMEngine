import { test } from "node:test";
import assert from "node:assert/strict";
import { frAnnouncement } from "./announce";

test("frAnnouncement: title carries the padded request number and the title", () => {
  const { title } = frAnnouncement({ number: 24, title: "Active-directory and directory-sync" });
  assert.equal(title, "Feature request #0000024: Active-directory and directory-sync");
});

test("frAnnouncement: detail includes the requested item (body) and the resolution note", () => {
  const { detail } = frAnnouncement({
    number: 24,
    title: "AD readiness",
    body: "AD/directory-sync fails the connection test even with an agent installed.",
    resolutionNote: "Fixed in PR #204 — ad-dc is optional now.",
  });
  assert.match(detail, /AD\/directory-sync fails the connection test/);
  assert.match(detail, /Resolution: Fixed in PR #204/);
  // sections are blank-line separated: body, then resolution.
  assert.equal(detail, "AD/directory-sync fails the connection test even with an agent installed.\n\nResolution: Fixed in PR #204 — ad-dc is optional now.");
});

test("frAnnouncement: an operator comment sits first, above the request", () => {
  const { detail } = frAnnouncement(
    { number: 7, title: "T", body: "the ask", resolutionNote: "done" },
    "  nice work team  "
  );
  assert.equal(detail, "nice work team\n\nthe ask\n\nResolution: done");
});

test("frAnnouncement: empty/whitespace pieces are dropped — no dangling separators", () => {
  // no comment, no resolution, only a body
  assert.equal(frAnnouncement({ number: 1, title: "x", body: "just the body" }, "   ").detail, "just the body");
  // nothing at all -> empty detail (messageText still has the title line)
  assert.equal(frAnnouncement({ number: 1, title: "x" }).detail, "");
  // resolution but no body -> only the resolution, no leading blank line
  assert.equal(frAnnouncement({ number: 1, title: "x", resolutionNote: "shipped" }).detail, "Resolution: shipped");
  // null body/note behave like empty
  assert.equal(frAnnouncement({ number: 1, title: "x", body: null, resolutionNote: null }, null).detail, "");
});
