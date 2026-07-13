// Restore Coretelligent's post-reset losses from profiles/coretelligent.json — the profile is the
// durable source of truth ([[db-reset-incident-2026-07-13]] wiped the DB-only edits: the `tap`
// onboarding system from c9f8684, the offboard wiring from wire-coretelligent-offboard.ts, the
// Delinea secret ids, and the runCloudOnOwnAgent flag from 7d8528a).
//
//   npx tsx --env-file=.env scripts/restore-coretelligent.ts            # dry run — prints the plan
//   npx tsx --env-file=.env scripts/restore-coretelligent.ts --apply    # writes
//
// Applies ONLY the coretelligent profile (never a full reseed — that would clobber other clients'
// in-app edits). Field mapping matches prisma/seed.ts exactly, with two safety rules on top:
//   - a Secret whose profile id is REPLACE_ME never overwrites a real externalId already in the DB
//   - top-level ClientSystem.config keys the seed mapping doesn't own (e.g. the post-reset
//     `onPremExchangeUri` set directly on the exchange system) are carried over, not dropped
import { readFileSync } from "fs";
import { join } from "path";
import { Prisma } from "@prisma/client";
import { db } from "../lib/db";

const APPLY = process.argv.includes("--apply");
const SEED_OWNED_CONFIG_KEYS = new Set(["onboard", "offboard", "dependsOn", "requiresApproval", "captureEvidence", "runLast"]);
const laneMap: Record<string, string> = { always: "always", "on-request": "on_request", "by-persona": "by_persona", never: "never" };

async function main() {
  // run from web/ like the seed (process.cwd() = web)
  const p = JSON.parse(readFileSync(join(process.cwd(), "..", "profiles", "coretelligent.json"), "utf8"));
  const client = await db.client.findUnique({ where: { slug: "coretelligent" } });
  if (!client) throw new Error("no client with slug 'coretelligent' — seed the roster first");
  console.log(`${APPLY ? "RESTORING" : "DRY RUN —"} ${client.name} (${client.slug})\n`);

  // 1. Secrets — profile ids win unless the profile still says REPLACE_ME and the DB has a real id.
  for (const [name, ref] of Object.entries<any>(p.secrets ?? {})) {
    const existing = await db.secret.findUnique({ where: { clientId_name: { clientId: client.id, name } } });
    const keepDb = ref.id === "REPLACE_ME" && existing && existing.externalId !== "REPLACE_ME";
    const target = keepDb ? existing!.externalId : ref.id;
    console.log(`  secret ${name.padEnd(16)} ${existing ? existing.externalId : "(new)"} -> ${target}${keepDb ? " (kept DB value)" : ""}`);
    if (!APPLY || keepDb) continue;
    await db.secret.upsert({
      where: { clientId_name: { clientId: client.id, name } },
      update: { externalId: ref.id, label: ref.label ?? null },
      create: { clientId: client.id, name, provider: ref.provider, externalId: ref.id, label: ref.label ?? null },
    });
  }

  // 2. ClientSystems — the seed.ts field mapping, plus the carry-over of unowned top-level config keys.
  console.log();
  for (const s of p.systems) {
    const fields = {
      mode: s.mode,
      onboardWhen: (laneMap[s.onboard?.when ?? "never"] ?? "never") as any,
      offboardWhen: (laneMap[s.offboard?.when ?? "never"] ?? "never") as any,
      dependsOn: s.dependsOn ?? [],
      requiresApproval: Boolean(s.onboard?.requiresApproval || s.offboard?.requiresApproval),
      captureEvidence: Boolean(s.onboard?.captureEvidence || s.offboard?.captureEvidence),
      secretNames: s.secrets ?? [],
      config: {
        onboard: s.onboard?.config ?? null,
        offboard: s.offboard?.config ?? null,
        dependsOn: { onboard: s.onboard?.dependsOn, offboard: s.offboard?.dependsOn },
        requiresApproval: { onboard: Boolean(s.onboard?.requiresApproval), offboard: Boolean(s.offboard?.requiresApproval) },
        captureEvidence: { onboard: Boolean(s.onboard?.captureEvidence), offboard: Boolean(s.offboard?.captureEvidence) },
        ...(s.runLast ? { runLast: true } : {}),
      } as Record<string, unknown>,
    };
    const existing = await db.clientSystem.findUnique({
      where: { clientId_systemKey: { clientId: client.id, systemKey: s.key } },
    });
    const carried: string[] = [];
    if (existing?.config && typeof existing.config === "object" && !Array.isArray(existing.config)) {
      for (const [k, v] of Object.entries(existing.config as Record<string, unknown>)) {
        if (SEED_OWNED_CONFIG_KEYS.has(k)) continue;
        fields.config[k] = v;
        carried.push(k);
      }
    }
    const offDeps = s.offboard?.dependsOn ? ` offboardDeps[${s.offboard.dependsOn.join(",") || "—"}]` : "";
    console.log(`  ${existing ? "update" : "CREATE"} ${s.key.padEnd(18)} on=${fields.onboardWhen} off=${fields.offboardWhen} deps[${fields.dependsOn.join(",") || "—"}]${offDeps}${s.runLast ? " runLast" : ""}${carried.length ? ` carried[${carried.join(",")}]` : ""}`);
    if (!APPLY) continue;
    await db.clientSystem.upsert({
      where: { clientId_systemKey: { clientId: client.id, systemKey: s.key } },
      update: { ...fields, config: fields.config as Prisma.InputJsonValue },
      create: { clientId: client.id, systemKey: s.key, ...fields, config: fields.config as Prisma.InputJsonValue },
    });
  }

  // 3. Cloud-step affinity (7d8528a): Coretelligent's EXO cert lives in its agent's Windows cert
  // store, so cloud jobs must run on the client's own agent — a plain column, not profile-carried.
  console.log(`\n  runCloudOnOwnAgent ${client.runCloudOnOwnAgent} -> true`);
  if (APPLY) await db.client.update({ where: { id: client.id }, data: { runCloudOnOwnAgent: true } });

  console.log(`\n${APPLY ? "Restored." : "Dry run only — re-run with --apply to write."}`);
}

main().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; }).finally(() => db.$disconnect());
