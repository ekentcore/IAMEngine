// Seeds the DB from profiles/*.json (hand-authored, authoritative) and then from
// profiles/generated/*.json (KB-generated drafts). Generated profiles only ENRICH existing
// roster clients (matched by slug during generation) — they never create new clients and
// never clobber a hand-authored profile.
// Run via: npx prisma db seed
import { PrismaClient } from "@prisma/client";
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";

const prisma = new PrismaClient();
const PROFILES = join(process.cwd(), "..", "profiles");
const GENERATED = join(PROFILES, "generated");

const backboneMap: Record<string, "entra" | "google" | "ad_synced" | "ad_standalone"> = {
  entra: "entra", google: "google", "ad-synced": "ad_synced", "ad-standalone": "ad_standalone",
};
const laneMap: Record<string, "always" | "on_request" | "never"> = {
  always: "always", "on-request": "on_request", never: "never",
};

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

type Source = "authored" | "generated";

async function applyProfile(p: any, source: Source, handAuthored: Set<string>): Promise<"applied" | "skipped"> {
  if (p.schemaVersion !== "2.0") return "skipped";
  const slug: string = p.client.id;

  const existing = await prisma.client.findUnique({ where: { slug } });
  if (source === "generated") {
    if (!existing) return "skipped"; // only enrich clients already in the roster
    if (handAuthored.has(slug)) return "skipped"; // never clobber an authoritative profile
  }

  const backbone = backboneMap[p.identity.backbone];
  if (!backbone) {
    console.warn(`skip ${slug}: unknown backbone "${p.identity.backbone}"`);
    return "skipped";
  }
  const client = await prisma.client.upsert({
    where: { slug },
    // both sources set backbone; generated only reaches here for an existing, un-authored
    // client. name is NOT updated (ServiceNow sync is authoritative for it); domains are.
    update: { backbone, pod: p.client.pod ?? undefined, primaryDomain: p.client.primaryDomain, domains: p.client.domains ?? [] },
    create: {
      slug, name: p.client.name, primaryDomain: p.client.primaryDomain,
      domains: p.client.domains ?? [], backbone, pod: p.client.pod ?? null,
    },
  });

  for (const [secName, ref] of Object.entries<any>(p.secrets ?? {})) {
    await prisma.secret.upsert({
      where: { clientId_name: { clientId: client.id, name: secName } },
      update: { externalId: ref.id, label: ref.label ?? null },
      create: { clientId: client.id, name: secName, provider: ref.provider, externalId: ref.id, label: ref.label ?? null },
    });
  }

  for (const s of p.systems) {
    // Build the full field set once so create and update can't drift apart.
    const fields = {
      mode: s.mode,
      onboardWhen: laneMap[s.onboard?.when ?? "never"] ?? "never",
      offboardWhen: laneMap[s.offboard?.when ?? "never"] ?? "never",
      dependsOn: s.dependsOn ?? [],
      requiresApproval: Boolean(s.onboard?.requiresApproval || s.offboard?.requiresApproval),
      captureEvidence: Boolean(s.onboard?.captureEvidence || s.offboard?.captureEvidence),
      secretNames: s.secrets ?? [],
      config: { onboard: s.onboard?.config ?? null, offboard: s.offboard?.config ?? null,
                dependsOn: { onboard: s.onboard?.dependsOn, offboard: s.offboard?.dependsOn } },
    };
    await prisma.clientSystem.upsert({
      where: { clientId_systemKey: { clientId: client.id, systemKey: s.key } },
      update: fields,
      create: { clientId: client.id, systemKey: s.key, ...fields },
    });
  }
  return "applied";
}

async function main() {
  for (const [key, name, buildTier, moduleName] of CATALOG) {
    await prisma.systemCatalog.upsert({
      where: { key }, update: { name, buildTier, moduleName },
      create: { key, name, buildTier, moduleName: moduleName ?? null },
    });
  }

  // Pass 1: hand-authored profiles (authoritative).
  const handAuthored = new Set<string>();
  for (const file of readdirSync(PROFILES).filter((f) => f.endsWith(".json") && !f.startsWith("_"))) {
    const p = JSON.parse(readFileSync(join(PROFILES, file), "utf8"));
    // Protect every hand-authored slug from the generated pass, even if we skip applying it
    // (e.g. raith.json is schema 1.0) — a generated draft must never clobber an authored file.
    if (p?.client?.id) handAuthored.add(p.client.id);
    if (await applyProfile(p, "authored", handAuthored) === "applied") {
      console.log(`authored: ${p.client.name} (${p.systems.length} systems)`);
    } else {
      console.warn(`skip ${file}: not schema 2.0`);
    }
  }

  // Pass 2: generated drafts (enrich existing roster clients only).
  let applied = 0, skipped = 0;
  if (existsSync(GENERATED)) {
    for (const file of readdirSync(GENERATED).filter((f) => f.endsWith(".json") && !f.startsWith("_"))) {
      const p = JSON.parse(readFileSync(join(GENERATED, file), "utf8"));
      (await applyProfile(p, "generated", handAuthored)) === "applied" ? applied++ : skipped++;
    }
    console.log(`generated: ${applied} applied (enriched roster clients), ${skipped} skipped (no roster match / authored)`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
