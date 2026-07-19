import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "slack-catalog-built",
  date: "2026-07-19",
  time: "17:30",
  title: "Slack was fully built but the catalog still said 'planned' - fixed, plus a build plan for what's actually left",
  items: [
    "Slack has run for real since the 2026-07-14 SCIM build (invite/deactivate, $DISPATCH['slack'], field-requirements, tests, help page) but web/lib/modules/catalog.ts and prisma/seed.ts still marked it planned with no moduleName - the Modules page was showing a false 'not built' badge on a system that's been live. Both now say built, with Coretelligent.Slack wired as the moduleName",
    "docs/modules/slack.md noted a slack-admin multi-workspace secret; the shipped module uses a single slack SCIM token (one workspace) - the doc now says so",
    "New docs/modules/_BUILD_PLAN.md: a consolidated build plan for every module that's genuinely still unwritten (sharepoint, teams, avd, mdm, dropbox, notion, printix, data-transfer, archive) - build steps, permissions/instructions, the exact Delinea FieldReq[] template to paste in, and the operator inputs (template ids, vendor API details, design decisions) each one needs before it can be built. tableau and uniflow are documented as manual-by-design, not backlog",
  ],
};
