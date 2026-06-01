// Seeds the DB from profiles/*.json (validated against profiles/_schema.json).
// Run via: npx prisma db seed  (configure in package.json "prisma": { "seed": ... })
import { PrismaClient } from "@prisma/client";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const prisma = new PrismaClient();
const PROFILES = join(process.cwd(), "..", "profiles");

const backboneMap: Record<string, "entra" | "google" | "ad_synced" | "ad_standalone"> = {
  entra: "entra", google: "google", "ad-synced": "ad_synced", "ad-standalone": "ad_standalone",
};
const laneMap: Record<string, "always" | "on_request" | "never"> = {
  always: "always", "on-request": "on_request", never: "never",
};

// Minimal catalog seed; buildTier 1 = built/core, 2 = next, 3 = long tail.
const CATALOG: Array<[string, string, number, string?]> = [
  ["servicenow", "ServiceNow", 1, "Coretelligent.ServiceNow"],
  ["m365", "Microsoft 365", 1, "Coretelligent.M365"],
  ["entra", "Entra", 1, "Coretelligent.M365"],
  ["exchange", "Exchange", 1, "Coretelligent.M365"],
  ["active-directory", "Active Directory", 2, "Coretelligent.ActiveDirectory"],
  ["directory-sync", "Entra Connect sync", 2, "Coretelligent.ActiveDirectory"],
  ["mimecast", "Mimecast", 2], ["adobe", "Adobe", 2], ["google-workspace", "Google Workspace", 2],
  ["knowbe4", "KnowBe4", 2], ["sharepoint", "SharePoint", 3], ["spanning", "Spanning", 3],
  ["zoom", "Zoom", 3], ["slack", "Slack", 3], ["egnyte", "Egnyte", 3], ["mdm", "MDM (Addigy/Jamf/Intune)", 3],
  ["proofpoint", "Proofpoint", 3], ["dropbox", "Dropbox", 3], ["perimeter81", "Perimeter 81", 3],
  ["teams", "Teams Phone", 3], ["avd", "Azure Virtual Desktop", 3], ["1password", "1Password", 3],
  ["tableau", "Tableau", 3], ["notion", "Notion", 3], ["printix", "Printix", 3],
  ["hardware", "Hardware", 3], ["workstation", "Workstation", 3], ["welcome-letter", "Welcome letter", 3],
  ["first-day-call", "First-day call", 3], ["case-resolution", "Case resolution", 1],
];

async function main() {
  for (const [key, name, buildTier, moduleName] of CATALOG) {
    await prisma.systemCatalog.upsert({
      where: { key }, update: { name, buildTier, moduleName },
      create: { key, name, buildTier, moduleName: moduleName ?? null },
    });
  }

  for (const file of readdirSync(PROFILES).filter((f) => f.endsWith(".json") && !f.startsWith("_"))) {
    const p = JSON.parse(readFileSync(join(PROFILES, file), "utf8"));
    if (p.schemaVersion !== "2.0") { console.warn(`skip ${file}: not schema 2.0`); continue; }

    const client = await prisma.client.upsert({
      where: { slug: p.client.id },
      update: { identity: p.identity, kb: p.kb ?? null },
      create: {
        slug: p.client.id, name: p.client.name, primaryDomain: p.client.primaryDomain,
        domains: p.client.domains ?? [], backbone: backboneMap[p.identity.backbone], pod: p.client.pod ?? null,
        identity: p.identity, kb: p.kb ?? null,
      },
    });

    for (const [secName, ref] of Object.entries<any>(p.secrets ?? {})) {
      await prisma.secret.upsert({
        where: { clientId_name: { clientId: client.id, name: secName } },
        update: { externalId: ref.id, label: ref.label ?? null },
        create: { clientId: client.id, name: secName, provider: ref.provider, externalId: ref.id, label: ref.label ?? null },
      });
    }

    for (const [seq, s] of p.systems.entries()) {
      await prisma.clientSystem.upsert({
        where: { clientId_systemKey: { clientId: client.id, systemKey: s.key } },
        update: { seq },
        create: {
          clientId: client.id, systemKey: s.key, seq, mode: s.mode,
          onboardWhen: laneMap[s.onboard?.when ?? "never"] ?? "never",
          offboardWhen: laneMap[s.offboard?.when ?? "never"] ?? "never",
          dependsOn: s.dependsOn ?? [],
          requiresApproval: Boolean(s.onboard?.requiresApproval || s.offboard?.requiresApproval),
          captureEvidence: Boolean(s.onboard?.captureEvidence || s.offboard?.captureEvidence),
          secretNames: s.secrets ?? [],
          config: { onboard: s.onboard?.config ?? null, offboard: s.offboard?.config ?? null,
                    dependsOn: { onboard: s.onboard?.dependsOn, offboard: s.offboard?.dependsOn } },
        },
      });
    }
    console.log(`seeded ${client.name} (${p.systems.length} systems)`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
