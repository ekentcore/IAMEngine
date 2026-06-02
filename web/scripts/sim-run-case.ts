// Watch a case run to a terminal status against the real DB + runner-service, using the
// simulated executor instead of a PowerShell runner — so nothing in any tenant changes. This
// is the "see onboarding/offboarding actually work end-to-end" companion to dry-run-um.ts.
//
//   # plan + run a fresh case for a seeded client:
//   npx tsx --env-file=.env scripts/sim-run-case.ts six-one offboard
//   # or run an already-planned case by id:
//   npx tsx --env-file=.env scripts/sim-run-case.ts <caseId>
import { db } from "@/lib/db";
import { makeCaseRepository } from "@/lib/cases/repository";
import { createAndPlanCase } from "@/lib/cases/planning-service";
import { makeRunnerService } from "@/lib/jobs/runner-service";
import { runCaseSimulation } from "@/lib/jobs/sim-executor";
import { loadRunReport, renderRunReportMarkdown } from "@/lib/cases/run-report";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: npx tsx --env-file=.env scripts/sim-run-case.ts <clientSlug> <onboard|offboard> | <caseId>");
  process.exit(1);
}

(async () => {
  try {
    let caseId: string;
    let clientSlug: string;

    if (args[1] === "onboard" || args[1] === "offboard") {
      clientSlug = args[0];
      const action = args[1];
      const payload =
        action === "onboard"
          ? { firstName: "Sim", lastName: "User", emailAddressNeeded: true }
          : { userToOffboard: "Sim User" };
      const out = await createAndPlanCase(
        makeCaseRepository(db),
        { clientSlug, action, subject: `Sim ${action} — Sim User`, payload },
        "cli:sim"
      );
      caseId = out.caseId;
      console.log(`planned ${action} for ${clientSlug}: ${out.jobCount} jobs (${out.manualCount} manual, ${out.approvalCount} approval) · status=${out.status}\n`);
    } else {
      caseId = args[0];
      const c = await db.caseRequest.findUnique({ where: { id: caseId }, select: { client: { select: { slug: true } } } });
      if (!c) throw new Error(`no case ${caseId}`);
      clientSlug = c.client.slug;
    }

    // A client-scoped agent so claim() only sees this client's jobs.
    const service = makeRunnerService(db);
    const agent = await service.enroll({ name: "sim-runner", scope: "client_network", clientSlug });
    const finalStatus = await runCaseSimulation(service, db, agent.id, caseId);

    const rr = await loadRunReport(db, caseId);
    if (rr) console.log(renderRunReportMarkdown(rr));
    console.log(`\ncase ${caseId} -> ${finalStatus}`);
  } catch (e) {
    console.error(`sim-run failed: ${(e as Error).message}`);
    process.exitCode = 2;
  } finally {
    await db.$disconnect();
  }
})();
