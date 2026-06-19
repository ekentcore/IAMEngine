// Wire Coretelligent's own OFFBOARD runbook as data — the data-driven replacement for the manual
// 6 steps + Offboarding_User.ps1. Idempotent upsert of the offboard ClientSystem rows with the
// ordering, approval gates, and per-step config the executors read.
//
//   npx tsx scripts/wire-coretelligent-offboard.ts            # dry run — prints the plan, writes nothing
//   npx tsx scripts/wire-coretelligent-offboard.ts --apply    # writes the ClientSystem rows
//
// SAFETY ORDERING (the plan's hard rule): convert-to-shared (exchange) is the prerequisite for the
// whole offboard — every destructive step lists `exchange` (and the sync) in its offboard dependsOn,
// so if the convert job fails the case fails and the rest is skipped (deriveCaseStatus). SentinelOne
// shutdown stays OFF and the S1 step requiresApproval. notify runs last (runLast).
//
// VALUES: the AD OUs + group are pulled verbatim from data/Offboarding_User.ps1 (the AD domain is
// coretelligent.LOCAL, not .com). The on-prem Exchange URI + notify sender are still TODO — set them
// here or adjust each system on the client page after.
import { Prisma } from "@prisma/client";
import { db } from "../lib/db";

const SLUG = process.env.CLIENT_SLUG ?? "coretelligent";
const APPLY = process.argv.includes("--apply");

// --- Coretelligent-specific values --------------------------------------------------------------
// From Offboarding_User.ps1: $disabledOU (line 91), the computer Move-ADObject target (line 338),
// and "Disabled Users" as the primary group (lines 421/426).
const DISABLED_USERS_OU = "OU=Disabled Users,OU=Users,OU=Coretelligent,DC=coretelligent,DC=local";
const DISABLED_COMPUTERS_OU = "OU=Disabled,OU=Computers,OU=Coretelligent,DC=coretelligent,DC=local";
const DISABLED_USERS_GROUP = "Disabled Users";
// From Offboarding_User.ps1 line 88-89 ($exchangeServer / $azsync). Better long-term home for the
// Exchange URI is the exchange-onprem secret's ConnectionUri field — this is just the seed default.
const ON_PREM_EXCHANGE_URI = "http://core-cce1-ex01.coretelligent.local/PowerShell/";
const AZSYNC_HOST = "CORE-CCE-AZSYNC.coretelligent.local";   // the Entra Connect host (directory-sync)
const NOTIFY_SENDER = "ekent@core.tech";                     // the mailbox the m365-admin app sends as
const OFFBOARD_RECIPIENTS = [
  "scott.camara@coretelligent.com", "todd.oblak@coretelligent.com", "evan.kent@coretelligent.com",
  "joe.aukofer@coretelligent.com", "miguel.gallegos@coretelligent.com", "anthony.bostock@coretelligent.com",
  "erik.truax@coretelligent.com", "jennifer.hughes@coretelligent.com", "justin.mascio@coretelligent.com",
]; // TODO confirm addresses

type Spec = {
  systemKey: string;
  mode: "api" | "manual";
  secretNames: string[];
  dependsOn: string[];       // offboard-lane deps (written into config.dependsOn.offboard)
  requiresApproval?: boolean;
  captureEvidence?: boolean;
  runLast?: boolean;
  config: Record<string, unknown>;
};

// Order here is documentation only — the planner topo-sorts on dependsOn.
const SPECS: Spec[] = [
  // 1. HARD STOP: convert mailbox to shared + add the manager as a Full Access delegate. Everything
  //    destructive depends on this completing.
  { systemKey: "exchange", mode: "api", secretNames: ["m365-admin", "exchange-onprem"], dependsOn: [],
    captureEvidence: true,
    config: { convertToShared: { skipIfMailboxOverGB: 50 }, delegateManagerFullAccess: true,
              blockMobileDevices: true, onPremExchangeUri: ON_PREM_EXCHANGE_URI } },

  // 2. Push the on-prem convert to the cloud, then the cloud steps can confirm SharedMailbox.
  { systemKey: "directory-sync", mode: "api", secretNames: ["ad-dc"], dependsOn: ["exchange"], config: { host: AZSYNC_HOST } },

  // 3. Entra: block sign-in + revoke sessions + disable & capture the registered device(s).
  { systemKey: "entra", mode: "api", secretNames: ["m365-admin"], dependsOn: ["exchange"], captureEvidence: true,
    config: { blockSignIn: true, revokeSessions: true, disableDevices: true, captureDevices: true, removeAllGroups: true } },

  // 4. M365: remove the license (after the mailbox is safely shared).
  { systemKey: "m365", mode: "api", secretNames: ["m365-admin"], dependsOn: ["exchange"],
    config: { removeLicense: {}, mailbox: { sizeThresholdGB: 50 } } },

  // 5. AD: disable user, set Disabled-Users primary group, strip groups, disable + move the computer.
  { systemKey: "active-directory", mode: "api", secretNames: ["ad-dc"], dependsOn: ["exchange", "directory-sync"],
    captureEvidence: true,
    config: { resetPassword: true, removeAllGroups: true, disableAccount: true,
              disabledUsersPrimaryGroup: DISABLED_USERS_GROUP, disabledUsersOu: DISABLED_USERS_OU,
              disableComputer: true, disabledComputersOu: DISABLED_COMPUTERS_OU } },

  // 6. SentinelOne: network-isolate the endpoint (shutdown OFF). Approval-gated.
  { systemKey: "sentinelone", mode: "api", secretNames: ["sentinelone"], dependsOn: ["entra"],
    requiresApproval: true, config: { shutdown: false } },

  // 7. Zoom: deactivate + revoke SSO token.
  { systemKey: "zoom", mode: "api", secretNames: ["zoom"], dependsOn: ["exchange"], config: { revokeSso: true } },

  // 8. App removals (supersede the manual "please remove from…" email). Deactivate by default.
  { systemKey: "duo", mode: "api", secretNames: ["duo"], dependsOn: ["m365"], config: {} },
  { systemKey: "xmatters", mode: "api", secretNames: ["xmatters"], dependsOn: ["m365"], config: {} },
  { systemKey: "logicmonitor", mode: "api", secretNames: ["logicmonitor"], dependsOn: ["m365"], config: {} },

  // 9. Notify LAST — communication email + SN case note.
  { systemKey: "notify", mode: "api", secretNames: ["m365-admin"], dependsOn: [], runLast: true,
    config: { sender: NOTIFY_SENDER, recipients: OFFBOARD_RECIPIENTS, caseNoteAddress: "internalsupport@core.tech" } },
];

// The new offboard systems aren't in SystemCatalog until `prisma db seed` runs; ClientSystem has a
// FK to SystemCatalog.key, so ensure these rows exist first (idempotent — matches seed.ts).
const NEW_CATALOG: Array<[string, string, number, string]> = [
  ["sentinelone", "SentinelOne", 2, "Coretelligent.SentinelOne"],
  ["duo", "Duo Security", 3, "Coretelligent.Duo"],
  ["xmatters", "xMatters", 3, "Coretelligent.XMatters"],
  ["logicmonitor", "LogicMonitor", 3, "Coretelligent.LogicMonitor"],
  ["notify", "Offboard notification", 3, "Coretelligent.Notify"],
];

async function main() {
  const client = await db.client.findUnique({ where: { slug: SLUG } });
  if (!client) throw new Error(`no client with slug '${SLUG}' — set CLIENT_SLUG or seed the client first`);
  console.log(`${APPLY ? "WIRING" : "DRY RUN —"} offboard for ${client.name} (${client.slug})\n`);

  if (APPLY) {
    for (const [key, name, buildTier, moduleName] of NEW_CATALOG) {
      await db.systemCatalog.upsert({
        where: { key }, update: { name, buildTier, moduleName }, create: { key, name, buildTier, moduleName },
      });
    }
  }

  for (const s of SPECS) {
    const config = {
      // offboard-lane settings the executor reads, plus the planner hints (lane deps / approval / runLast)
      offboard: s.config,
      dependsOn: { offboard: s.dependsOn },
      requiresApproval: { offboard: Boolean(s.requiresApproval) },
      captureEvidence: { offboard: Boolean(s.captureEvidence) },
      ...(s.runLast ? { runLast: true } : {}),
    } as Prisma.InputJsonValue;
    const line = `  ${s.systemKey.padEnd(18)} deps[${s.dependsOn.join(",") || "—"}]${s.requiresApproval ? " APPROVAL" : ""}${s.runLast ? " runLast" : ""}  secrets[${s.secretNames.join(",")}]`;
    console.log(line);
    if (!APPLY) continue;
    await db.clientSystem.upsert({
      where: { clientId_systemKey: { clientId: client.id, systemKey: s.systemKey } },
      update: { mode: s.mode, offboardWhen: "always", dependsOn: s.dependsOn, requiresApproval: Boolean(s.requiresApproval),
                captureEvidence: Boolean(s.captureEvidence), secretNames: s.secretNames, config },
      create: { clientId: client.id, systemKey: s.systemKey, mode: s.mode, onboardWhen: "never", offboardWhen: "always",
                dependsOn: s.dependsOn, requiresApproval: Boolean(s.requiresApproval), captureEvidence: Boolean(s.captureEvidence),
                secretNames: s.secretNames, config },
    });
  }

  console.log(`\n${APPLY ? "Wired" : "Would wire"} ${SPECS.length} offboard systems.`);
  if (!APPLY) console.log("Re-run with --apply to write. Confirm the TODO placeholders (OUs, on-prem URI, recipients, secret refs) first.");
  else console.log("Next: confirm the Secret rows (Delinea refs) exist for the secretNames above, then plan a test offboard (dry-run).");
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); }).finally(() => db.$disconnect());
