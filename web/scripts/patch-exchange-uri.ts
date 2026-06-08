// One-off: ensure the on-prem Exchange PowerShell URI is present in coretelligent's exchange config,
// both on the ClientSystem (future plans) and on any not-yet-completed exchange Job.request.config
// (the current re-run). Pass --apply to write; default is a dry inspection.
import { db } from "@/lib/db";

const URI = "http://core-cce1-ex01.coretelligent.local/PowerShell/";
const APPLY = process.argv.includes("--apply");

async function main() {
  const client = await db.client.findFirst({ where: { OR: [{ slug: "coretelligent" }, { name: "Coretelligent" }] } });
  if (!client) throw new Error("coretelligent client not found");

  const cs = await db.clientSystem.findFirst({ where: { clientId: client.id, systemKey: "exchange" } });
  console.log("=== ClientSystem.config (exchange) ===");
  console.log(JSON.stringify(cs?.config, null, 2));

  const jobs = await db.job.findMany({
    where: { systemKey: "exchange", case: { clientId: client.id }, status: { not: "succeeded" } },
    select: { id: true, status: true, caseRequestId: true, request: true },
  });
  console.log(`\n=== ${jobs.length} non-terminal exchange job(s) ===`);
  for (const j of jobs) {
    const req = (j.request ?? {}) as Record<string, unknown>;
    const cfg = (req.config ?? {}) as Record<string, unknown>;
    console.log(`job ${j.id} [${j.status}] config keys=${Object.keys(cfg).join(",")} onPremExchangeUri=${JSON.stringify(cfg.onPremExchangeUri)}`);
  }

  if (!APPLY) {
    console.log("\n(dry run — pass --apply to write)");
    return;
  }

  // Patch ClientSystem.config — the planner stores onboard config under .onboard.config (v2.1) but
  // tolerate a flat shape too; set the key wherever the existing enableRemoteMailbox lives.
  if (cs) {
    const cfg = JSON.parse(JSON.stringify(cs.config ?? {})) as Record<string, any>;
    const target = cfg.onboard?.config ?? cfg.onboard ?? cfg;
    target.onPremExchangeUri = URI;
    await db.clientSystem.update({ where: { id: cs.id }, data: { config: cfg } });
    console.log(`\npatched ClientSystem ${cs.id}`);
  }

  for (const j of jobs) {
    const req = JSON.parse(JSON.stringify(j.request ?? {})) as Record<string, any>;
    req.config = req.config ?? {};
    req.config.onPremExchangeUri = URI;
    await db.job.update({ where: { id: j.id }, data: { request: req } });
    console.log(`patched job ${j.id}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
