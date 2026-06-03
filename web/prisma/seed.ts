// Seeds the DB from profiles/*.json (hand-authored, authoritative) and then from
// profiles/generated/*.json (KB-generated drafts). Generated profiles only ENRICH existing
// roster clients (matched by slug during generation) — they never create new clients and
// never clobber a hand-authored profile.
// Run via: npx prisma db seed
import { PrismaClient, Prisma } from "@prisma/client";
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";

const prisma = new PrismaClient();
const PROFILES = join(process.cwd(), "..", "profiles");
// Generated drafts are produced by tools/profile-generator (the canonical generator) into
// profiles/_drafts/. Pass 2 enriches existing roster clients from these.
const GENERATED = join(PROFILES, "_drafts");

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
  ["mimecast", "Mimecast", 2], ["adobe", "Adobe", 2], ["google-workspace", "Google Workspace", 2, "Coretelligent.GoogleWorkspace"],
  ["knowbe4", "KnowBe4", 2], ["sharepoint", "SharePoint", 3], ["spanning", "Spanning", 3],
  ["zoom", "Zoom", 3], ["slack", "Slack", 3], ["egnyte", "Egnyte", 3], ["mdm", "MDM (Addigy/Jamf/Intune)", 3],
  ["proofpoint", "Proofpoint", 3], ["dropbox", "Dropbox", 3], ["perimeter81", "Perimeter 81", 3],
  ["teams", "Teams Phone", 3], ["avd", "Azure Virtual Desktop", 3], ["1password", "1Password", 3],
  ["tableau", "Tableau", 3], ["notion", "Notion", 3], ["printix", "Printix", 3],
  ["hardware", "Hardware", 3], ["workstation", "Workstation", 3], ["welcome-letter", "Welcome letter", 3],
  ["first-day-call", "First-day call", 3], ["case-resolution", "Case resolution", 1],
  // long-tail keys the Phase-6 generator can emit; needed so a promoted draft seeds without a FK error
  ["data-transfer", "Data transfer", 2], ["archive", "Archive", 3],
  ["egnyte-sync-server", "Egnyte Sync Server", 3], ["address-book", "Printer address book", 3],
  ["equipment-return", "Equipment return", 3],
];

// Normalised client-name key for matching generated profiles to roster clients (whose slugs
// are CORE ids, so slug equality never matches a name-slugged generated profile).
function normName(s: string): string {
  return (s || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}
function stripSuffix(n: string): string {
  return n.replace(/\b(llc|inc|lp|llp|ltd|co|corp|corporation|company|holdings|partners|capital|group|management|the)\b/g, " ").replace(/\s+/g, " ").trim();
}

async function upsertSecretsAndSystems(clientId: string, p: any): Promise<void> {
  for (const [secName, ref] of Object.entries<any>(p.secrets ?? {})) {
    await prisma.secret.upsert({
      where: { clientId_name: { clientId, name: secName } },
      update: { externalId: ref.id, label: ref.label ?? null },
      create: { clientId, name: secName, provider: ref.provider, externalId: ref.id, label: ref.label ?? null },
    });
  }
  for (const s of p.systems) {
    // Build the full field set once so create and update can't drift apart.
    const fields = {
      mode: s.mode,
      onboardWhen: laneMap[s.onboard?.when ?? "never"] ?? "never",
      offboardWhen: laneMap[s.offboard?.when ?? "never"] ?? "never",
      dependsOn: s.dependsOn ?? [],
      // collapsed columns kept for the UI's coarse "needs approval / captures evidence" badge…
      requiresApproval: Boolean(s.onboard?.requiresApproval || s.offboard?.requiresApproval),
      captureEvidence: Boolean(s.onboard?.captureEvidence || s.offboard?.captureEvidence),
      secretNames: s.secrets ?? [],
      // …while config carries the authoritative PER-LANE flags + lane config + lane deps the
      // orchestrator resolves (so an offboard-only approval gate never fires on an onboard).
      config: {
        onboard: s.onboard?.config ?? null,
        offboard: s.offboard?.config ?? null,
        dependsOn: { onboard: s.onboard?.dependsOn, offboard: s.offboard?.dependsOn },
        requiresApproval: { onboard: Boolean(s.onboard?.requiresApproval), offboard: Boolean(s.offboard?.requiresApproval) },
        captureEvidence: { onboard: Boolean(s.onboard?.captureEvidence), offboard: Boolean(s.offboard?.captureEvidence) },
      },
    };
    await prisma.clientSystem.upsert({
      where: { clientId_systemKey: { clientId, systemKey: s.key } },
      update: fields,
      create: { clientId, systemKey: s.key, ...fields },
    });
  }
}

// Drop fields a human edited in the UI (Client.editedFields) from a seed update, so a reseed
// doesn't clobber manual corrections — matching the routine sync's behaviour. A field that was
// never edited is written normally.
function stripEdited<T extends Record<string, any>>(data: T, editedFields: string[]): Partial<T> {
  const d: Record<string, any> = { ...data };
  if (editedFields.includes("primaryDomain")) { delete d.primaryDomain; delete d.domains; }
  if (editedFields.includes("backbone")) delete d.backbone;
  if (editedFields.includes("usernamePattern")) delete d.identity; // identity holds usernamePatterns
  return d as Partial<T>;
}

// Hand-authored profiles are authoritative: upsert the client by its own slug (create
// allowed). Returns the client id (so the generated pass can protect it by id, not name).
async function applyAuthored(p: any): Promise<string | null> {
  if (p.schemaVersion !== "2.0") return null;
  const backbone = backboneMap[p.identity.backbone];
  if (!backbone) { console.warn(`skip ${p.client.id}: unknown backbone "${p.identity.backbone}"`); return null; }
  const existing = await prisma.client.findUnique({ where: { slug: p.client.id }, select: { editedFields: true } });
  const update = stripEdited(
    { backbone, pod: p.client.pod ?? undefined, primaryDomain: p.client.primaryDomain, domains: p.client.domains ?? [], identity: p.identity ?? undefined },
    existing?.editedFields ?? []
  );
  const client = await prisma.client.upsert({
    where: { slug: p.client.id },
    update,
    create: { slug: p.client.id, name: p.client.name, primaryDomain: p.client.primaryDomain, domains: p.client.domains ?? [], backbone, pod: p.client.pod ?? null, identity: p.identity ?? undefined },
  });
  await upsertSecretsAndSystems(client.id, p);
  return client.id;
}

async function main() {
  for (const [key, name, buildTier, moduleName] of CATALOG) {
    await prisma.systemCatalog.upsert({
      where: { key }, update: { name, buildTier, moduleName },
      create: { key, name, buildTier, moduleName: moduleName ?? null },
    });
  }

  // Pass 1: hand-authored profiles (authoritative). Collect their client ids to protect them
  // (by id, not name) from the generated pass.
  const curatedIds = new Set<string>();
  for (const file of readdirSync(PROFILES).filter((f) => f.endsWith(".json") && !f.startsWith("_"))) {
    const p = JSON.parse(readFileSync(join(PROFILES, file), "utf8"));
    const id = await applyAuthored(p);
    if (id) { curatedIds.add(id); console.log(`authored: ${p.client.name} (${p.systems.length} systems)`); }
    else console.warn(`skip ${file}: not schema 2.0`);
  }

  // Pass 2: generated drafts, matched to a client by NAME (then domain), since roster slugs
  // are CORE ids and won't equal a name-slugged generated profile. A curated client keeps its
  // authored systems but STILL gets its KB runbook (the steps are informational).
  let enriched = 0, curatedRb = 0, nonV2 = 0, unmatched = 0, runbook = 0;
  if (existsSync(GENERATED)) {
    const clients = await prisma.client.findMany({ select: { id: true, name: true, primaryDomain: true, editedFields: true } });
    const editedById = new Map(clients.map((c) => [c.id, c.editedFields]));
    const byName = new Map<string, string>();
    const byDomain = new Map<string, string>();
    const strippedGroups = new Map<string, Set<string>>();
    for (const c of clients) {
      byName.set(normName(c.name), c.id);
      if (c.primaryDomain) byDomain.set(c.primaryDomain.toLowerCase(), c.id);
      const sk = stripSuffix(normName(c.name));
      if (sk) (strippedGroups.get(sk) ?? strippedGroups.set(sk, new Set()).get(sk)!).add(c.id);
    }
    const byStrippedUnique = new Map<string, string>();
    for (const [k, ids] of strippedGroups) if (ids.size === 1) byStrippedUnique.set(k, [...ids][0]);

    for (const file of readdirSync(GENERATED).filter((f) => f.endsWith(".json") && !f.endsWith(".runbook.json") && !f.startsWith("_"))) {
      const p = JSON.parse(readFileSync(join(GENERATED, file), "utf8"));
      if (p.schemaVersion !== "2.0") { nonV2++; continue; }
      const nn = normName(p.client.name);
      const clientId =
        byName.get(nn) ??
        (p.client.primaryDomain ? byDomain.get(String(p.client.primaryDomain).toLowerCase()) : undefined) ??
        byStrippedUnique.get(stripSuffix(nn));
      if (!clientId) { unmatched++; continue; } // KB client not in the roster
      if (curatedIds.has(clientId)) {
        runbook += await loadRunbook(clientId, p.client.id); // keep authored systems; load runbook
        curatedRb++;
      } else {
        const backbone = backboneMap[p.identity.backbone];
        const update = stripEdited({ ...(backbone ? { backbone } : {}), pod: p.client.pod ?? undefined, identity: p.identity ?? undefined }, editedById.get(clientId) ?? []);
        await prisma.client.update({ where: { id: clientId }, data: update });
        await upsertSecretsAndSystems(clientId, p);
        runbook += await loadRunbook(clientId, p.client.id);
        enriched++;
      }
    }
    console.log(`generated: ${enriched} enriched, ${curatedRb} curated (runbook only), ${nonV2} non-2.0, ${unmatched} no roster match; ${runbook} runbook sections loaded`);
  }
}

// Load <slug>.runbook.json (the full step-by-step, modeled + unmodeled) into RunbookSection.
async function loadRunbook(clientDbId: string, slug: string): Promise<number> {
  const path = join(GENERATED, `${slug}.runbook.json`);
  if (!existsSync(path)) return 0;
  const items = JSON.parse(readFileSync(path, "utf8")) as Array<{
    action: string; seq: number; systemKey: string | null; title: string; status: string; guess: string | null; steps: string[]; kbArticle?: string | null; artifacts?: unknown[];
  }>;
  await prisma.runbookSection.deleteMany({ where: { clientId: clientDbId } });
  if (items.length === 0) return 0;
  await prisma.runbookSection.createMany({
    data: items.map((i) => ({
      clientId: clientDbId,
      action: i.action.startsWith("off") ? "offboard" : "onboard", // "offboarding"/"offboard" -> offboard
      seq: i.seq,
      systemKey: i.systemKey ?? null,
      title: i.title,
      status: i.status,
      guess: i.guess ?? null,
      steps: i.steps ?? [],
      kbArticle: i.kbArticle ?? null,
      artifacts: i.artifacts && i.artifacts.length ? (i.artifacts as Prisma.InputJsonValue) : undefined,
    })),
  });
  return items.length;
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
