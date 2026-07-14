#!/usr/bin/env node
// BayPine (core1186): wire up the offboard steps its runbook asks for but its profile never carried.
//
// The runbook says "Remove the user's license from their email." The generated profile only ever got
// `{"when":"always"}` for every system — no config at all — so the executor skipped BOTH the license
// removal (gated on `removeLicense`) and the shared-mailbox conversion (gated on `convertToShared`).
// Nothing failed; the work was simply never requested.
//
// Order matters and is the whole point: an unlicensed mailbox that is NOT shared is purged by Exchange
// after its 30-day grace. So:
//
//   1. m365      block sign-in, revoke sessions, remove groups   (containment first)
//   2. exchange  convert the mailbox to SHARED (skipped over 50GB — a big mailbox needs its licence)
//   3. entra     remove the licence            <- depends on exchange, so it cannot run before the convert
//
// `entra` is the same executor as `m365` (an alias), so putting removeLicense on the entra lane is how
// you say "remove it, but later" — and m365 carries removeLicense.defer/removedBy to say "not here".
//
// Usage:  node scripts/baypine-offboard-license.mjs [--apply]
//         (no flag = dry run; prints the before/after and writes nothing)
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const SLUG = "core1186";
const APPLY = process.argv.includes("--apply");

// Only the three lanes that matter. Everything else on the case is left exactly as it is.
const CHANGES = {
  m365: {
    config: {
      blockSignIn: true,
      removeAllGroups: true,
      // Explicitly NOT here: the mailbox has to be shared first, and Exchange runs after this step.
      removeLicense: { defer: true, removedBy: "entra", note: "Removed in the Entra step, after the mailbox is converted to shared." },
      mailbox: { sizeThresholdGB: 50 },
    },
  },
  exchange: {
    config: {
      convertToShared: { skipIfMailboxOverGB: 50 },
      blockMobileDevices: true,
    },
  },
  entra: {
    config: {
      // The licence comes off HERE — after exchange has converted the mailbox.
      removeLicense: {},
      mailbox: { sizeThresholdGB: 50 },
    },
    // The dependency IS the safety guarantee: entra cannot be claimed until exchange has succeeded.
    dependsOn: ["exchange"],
  },
};

const client = await db.client.findUnique({ where: { slug: SLUG }, select: { id: true, name: true } });
if (!client) {
  console.error(`no client with slug ${SLUG}`);
  process.exit(1);
}
console.log(`${client.name} (${SLUG})\n`);

for (const [systemKey, change] of Object.entries(CHANGES)) {
  const row = await db.clientSystem.findFirst({
    where: { clientId: client.id, systemKey },
    select: { id: true, systemKey: true, dependsOn: true, config: true },
  });
  if (!row) {
    console.log(`  ${systemKey}: NOT PRESENT on this client — skipped`);
    continue;
  }
  const cfg = { ...(row.config ?? {}) }; // preserve intent/captureEvidence/requiresApproval etc.
  const before = { offboard: cfg.offboard ?? null, dependsOn: row.dependsOn };
  cfg.offboard = change.config;
  const dependsOn = change.dependsOn ?? row.dependsOn;

  console.log(`  ${systemKey}`);
  console.log(`    before: offboard=${JSON.stringify(before.offboard)} dependsOn=${JSON.stringify(before.dependsOn)}`);
  console.log(`    after : offboard=${JSON.stringify(cfg.offboard)} dependsOn=${JSON.stringify(dependsOn)}`);

  if (APPLY) {
    await db.clientSystem.update({ where: { id: row.id }, data: { config: cfg, dependsOn } });
    console.log(`    APPLIED`);
  }
}

console.log(APPLY ? "\napplied." : "\ndry run — nothing written. Re-run with --apply to write.");
await db.$disconnect();
