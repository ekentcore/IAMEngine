#!/usr/bin/env node
// A client whose runbook FORBIDS removing the leaver's licence now gets a manual checklist item saying
// so — because "the engine didn't remove the licence" and "the engine deliberately left the licence
// alone, per the runbook" look identical on a case, and the first one is the bug we just spent the day
// fixing. Without this note, the next engineer sees a licensed leaver and has no way to know it was
// intentional. A manual step is the right shape: it is a first-class checklist item on the case, it is
// never silently skipped, and a human ticks it off.
//
// Only clients with an explicit runbook instruction get this. A client whose runbook simply doesn't
// mention licences is NOT "intentional" — it's unknown, and inventing a note would be a lie.
//
// Usage:  node scripts/offboard-licence-manual-note.mjs [--apply]
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const KEY = "license-review";

// slug -> the note the case will carry, quoting the runbook so the reason travels with the step.
const NOTES = {
  core1387: {
    why: "runbook: \"NOTE: Do NOT remove the license.\"",
    note: "License NOT removed — this is intentional. This client's runbook says: \"NOTE: Do NOT remove the license.\" The mailbox is still converted to shared and sign-in is blocked; the license is left in place on purpose. Do not 'fix' this by removing it — confirm with the client first.",
  },
};

// The catalog row the manual step hangs off. moduleName null = no executor, so it can only ever be a
// human checklist item.
const existing = await db.systemCatalog.findUnique({ where: { key: KEY } });
if (!existing) {
  console.log(`SystemCatalog: creating '${KEY}'`);
  if (APPLY) {
    await db.systemCatalog.create({
      data: { key: KEY, name: "License review", defaultMode: "manual", supportsOnboard: false, supportsOffboard: true, buildTier: 1, moduleName: null },
    });
  }
} else {
  console.log(`SystemCatalog: '${KEY}' already present`);
}

for (const [slug, spec] of Object.entries(NOTES)) {
  const c = await db.client.findUnique({ where: { slug }, select: { id: true, name: true, systems: { select: { id: true, systemKey: true } } } });
  if (!c) { console.log(`  ${slug}: no such client — skipped`); continue; }

  const row = c.systems.find((s) => s.systemKey === KEY);
  const config = {
    intent: { offboard: "disable" },
    onboard: null,
    offboard: { note: spec.note, why: spec.why },
    dependsOn: {},
    captureEvidence: { onboard: false, offboard: false },
    requiresApproval: { onboard: false, offboard: false },
  };

  console.log(`  ${slug} (${c.name}): ${row ? "updating" : "adding"} the '${KEY}' manual step`);
  console.log(`     ${spec.note.slice(0, 100)}…`);
  if (!APPLY) continue;

  if (row) {
    await db.clientSystem.update({ where: { id: row.id }, data: { mode: "manual", offboardWhen: "always", config } });
  } else {
    await db.clientSystem.create({
      data: {
        clientId: c.id, systemKey: KEY, mode: "manual",
        onboardWhen: "never", offboardWhen: "always",
        // Runs after the licence-owning lane would have — so it reads as "…and here's why it didn't".
        dependsOn: ["entra"], requiresApproval: false, captureEvidence: false, secretNames: [],
        config,
      },
    });
  }
}

console.log(APPLY ? "\napplied." : "\ndry run — nothing written. Re-run with --apply.");
await db.$disconnect();
