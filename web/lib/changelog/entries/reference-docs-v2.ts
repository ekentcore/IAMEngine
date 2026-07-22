import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "reference-docs-v2",
  date: "2026-07-22",
  time: "10:00",
  title: "Reference documents refreshed to version 2.0",
  items: [
    "The four reference documents in /docs (Client Overview, Setup and Configuration, Security Design, Internal Reference) are updated to version 2.0, each with a version-history table at the end recording what changed since v1.0 (14 July 2026)",
    "Folded in the features shipped since v1.0: automatic Microsoft 365 and Google Workspace setup, the automatic browser credential setup for Adobe/Zoom/Egnyte/KnowBe4/Spanning/Mimecast, the Google key converter, offboarding's hide-from-GAL and convert-to-shared defaults with their opt-outs, the specific-password option, and the client-onboarding/client-offboarding roles with archiving as its own capability",
    "publish-seed-doc.ts gains a --major flag so the seed sync can publish a major version (1.0 → 2.0), not only a minor bump; the seed baseline for fresh installs is now 2.0",
    "Publish to the live DB per document with, e.g., npx tsx scripts/publish-seed-doc.ts --slug client-overview --publish --major --note \"2.0 refresh\"",
  ],
};
