// Manually dry-run a real UM through the pipeline: ServiceNow fetch -> action detection ->
// client match -> identity derivation -> plan -> PLAYBOOK. No runner executes, so nothing in
// any tenant (M365/AD/…) changes — it only reads ServiceNow and writes a CaseRequest row to the
// dev DB (idempotent on the UM number). This is the safe "run it against a real ticket" test.
//
//   npx tsx --env-file=.env scripts/dry-run-um.ts UM0028680
import { db } from "@/lib/db";
import { importCaseFromServiceNow } from "@/lib/cases/import-service";
import { loadPlaybook, renderPlaybookMarkdown } from "@/lib/cases/playbook";
import { snConfigFromEnv } from "@/lib/servicenow/gateway";
import { fetchIntakeFields, formatIntakeFields } from "@/lib/servicenow/intake-fields";

const um = process.argv[2];
if (!um) {
  console.error("usage: npx tsx --env-file=.env scripts/dry-run-um.ts <UMxxxx>");
  process.exit(1);
}

(async () => {
  // 1. The intake form first — every field the requester filled in (with values), then the
  //    blanks. Independent of planning, so it shows even if the client isn't onboarded yet.
  const intake = await fetchIntakeFields(snConfigFromEnv(), um);
  if (intake) console.log(formatIntakeFields(intake) + "\n");
  else console.log(`no ServiceNow record for ${um}\n`);

  // 2. Plan the case + render the playbook (the exact scripts each step will run).
  const res = await importCaseFromServiceNow(db, um, "cli:dry-run");
  if (!res.ok) {
    console.error(`plan skipped (${res.code}): ${res.error}`);
    await db.$disconnect();
    return;
  }
  const o = res.outcome;
  console.log(
    `case ${res.caseNumber} ${res.alreadyImported ? "(already imported)" : "(planned now)"} ` +
      `-> ${o.jobCount} jobs (${o.manualCount} manual, ${o.approvalCount} approval) · status=${o.status}\n`
  );
  const pb = await loadPlaybook(db, o.caseId);
  if (pb) console.log(renderPlaybookMarkdown(pb));
  await db.$disconnect();
})();
