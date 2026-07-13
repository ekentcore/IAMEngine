/* Measure KB discovery against the LIVE ServiceNow roster: for each account, does findClientKbs
 * pick an onboarding + offboarding guide, and does the pick look right?
 *
 *   npx tsx scripts/audit-kb-discovery.ts [limit]
 *
 * Throwaway audit for the import-by-CORE-id build — the unit tests pin the scorer's behaviour on
 * fixtures, this checks the fixtures resemble reality across the whole fleet.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { snConfigFromEnv, fetchSnAccounts } from "../lib/servicenow/gateway";
import { findClientKbs } from "../lib/servicenow/kb-discovery";

function loadEnvFiles(): void {
  for (const p of [resolve(__dirname, "..", ".env"), resolve(__dirname, "..", "..", ".env")]) {
    let text: string;
    try { text = readFileSync(p, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || line.trim().startsWith("#")) continue;
      if (process.env[m[1]] !== undefined) continue;
      let v = m[2];
      const dq = v.match(/^"([^"]*)"/);
      if (dq) v = dq[1]; else v = v.replace(/\s+#.*$/, "");
      process.env[m[1]] = v.trim();
    }
  }
}
loadEnvFiles();

async function main() {
  const limit = Number(process.argv[2] ?? "40");
  const cfg = snConfigFromEnv();
  const accounts = (await fetchSnAccounts(cfg)).slice(0, limit);
  let both = 0, onboardOnly = 0, offboardOnly = 0, none = 0, noDomain = 0;

  for (const a of accounts) {
    const name = a.name?.display_value ?? "";
    const core = a.u_core_id?.display_value ?? "-";
    const domain = (a as unknown as { sys_domain?: { value?: string } }).sys_domain?.value ?? "";
    if (!domain) { noDomain++; console.log(`${core.padEnd(9)} ${name}\n   NO DOMAIN`); continue; }

    const r = await findClientKbs(cfg, domain);
    if (r.onboard && r.offboard) both++;
    else if (r.onboard) onboardOnly++;
    else if (r.offboard) offboardOnly++;
    else none++;

    const extra = r.candidates.length - (r.onboard ? 1 : 0) - (r.offboard ? 1 : 0);
    console.log(
      `${core.padEnd(9)} ${name}\n` +
        `   on : ${r.onboard ? `${r.onboard.number} (${r.onboard.score}) ${r.onboard.title}` : "— none —"}\n` +
        `   off: ${r.offboard ? `${r.offboard.number} (${r.offboard.score}) ${r.offboard.title}` : "— none —"}` +
        (extra > 0 ? `\n   (+${extra} other candidate(s): ${r.candidates.filter((c) => c !== r.onboard && c !== r.offboard).map((c) => c.title).join(" | ")})` : "")
    );
  }

  console.log(
    `\n== ${accounts.length} accounts: both=${both} onboard-only=${onboardOnly} offboard-only=${offboardOnly} none=${none} no-domain=${noDomain}`
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
