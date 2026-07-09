// Tier-1 simulated Coretelligent onboard: plan a realistic new-hire (role/location/title that
// hit a v2.1 persona), DUMP the resolved active-directory job config (OU / group union /
// attributes — the v2.1 resolution proof), then run the whole case to a terminal status via the
// simulated executor (no PowerShell runner, no tenant, no Delinea). Nothing changes in any system.
//   npx tsx --env-file=.env scripts/sim-coretelligent-onboard.ts
import { db } from "@/lib/db";
import { makeCaseRepository } from "@/lib/cases/repository";
import { createAndPlanCase } from "@/lib/cases/planning-service";
import { makeRunnerService } from "@/lib/jobs/runner-service";
import { runCaseSimulation } from "@/lib/jobs/sim-executor";
import { loadRunReport, renderRunReportMarkdown } from "@/lib/cases/run-report";

const SLUG = "coretelligent";
// A realistic intake matching the Field Services persona + the CA location (the same case the
// engine test proves: OU=CA,OU=Field Services,…, the global+role group union, CA attributes).
const PAYLOAD = {
  firstName: "John",
  lastName: "Doe",
  department: "Field Services",
  jobTitle: "Senior Client Support Engineer",
  officeLocation: "CA",
  employmentType: "Full-Time",
  managerName: "Jane Boss",
  startDate: "06/15/26",
  emailAddressNeeded: true,
  officeLineRequired: true,
};

(async () => {
  try {
    console.log(`Planning a simulated onboard for ${SLUG}: ${PAYLOAD.firstName} ${PAYLOAD.lastName} — ${PAYLOAD.department} / ${PAYLOAD.officeLocation}\n`);
    const out = await createAndPlanCase(
      makeCaseRepository(db),
      { clientSlug: SLUG, action: "onboard", subject: `Sim onboard — ${PAYLOAD.firstName} ${PAYLOAD.lastName}`, payload: PAYLOAD },
      "cli:sim"
    );
    console.log(`planned: ${out.jobCount} jobs (${out.manualCount} manual, ${out.approvalCount} approval) · status=${out.status}\n`);

    // Dump the resolved config for the directory job(s) — this is the v2.1 resolution made concrete.
    const jobs = await db.job.findMany({
      where: { caseRequestId: out.caseId },
      select: { systemKey: true, request: true },
      orderBy: { systemKey: "asc" },
    });
    for (const j of jobs) {
      if (!["active-directory", "entra", "m365", "exchange"].includes(j.systemKey)) continue;
      const req = (j.request ?? {}) as Record<string, unknown>;
      const cfg = (req.config ?? {}) as Record<string, unknown>;
      console.log(`── resolved config · ${j.systemKey} ──`);
      if (cfg.ou) console.log(`  OU: ${cfg.ou}`);
      if (Array.isArray(cfg.groups)) console.log(`  groups (${cfg.groups.length}): ${cfg.groups.join(", ")}`);
      if (cfg.attributes && typeof cfg.attributes === "object") {
        console.log(`  attributes:`);
        for (const [k, v] of Object.entries(cfg.attributes as Record<string, unknown>)) console.log(`     ${k} = ${JSON.stringify(v)}`);
      }
      if (cfg.licenses) console.log(`  licenses: ${JSON.stringify(cfg.licenses)}`);
      if (cfg.enableRemoteMailbox) console.log(`  enableRemoteMailbox: ${JSON.stringify(cfg.enableRemoteMailbox)}`);
      console.log();
    }

    // Run the case to a terminal status with the simulated executor.
    const service = makeRunnerService(db);
    const agent = await service.enroll({ name: "sim-runner", scope: "client_network", clientSlug: SLUG });
    const finalStatus = await runCaseSimulation(service, db, agent.id, out.caseId);

    const rr = await loadRunReport(db, out.caseId);
    if (rr) console.log(renderRunReportMarkdown(rr));
    console.log(`\ncase ${out.caseId} -> ${finalStatus}`);
  } catch (e) {
    console.error(`sim-run failed: ${(e as Error).message}`);
    console.error((e as Error).stack);
    process.exitCode = 2;
  } finally {
    await db.$disconnect();
  }
})();
