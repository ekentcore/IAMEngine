/* Recover the per-client Delinea secret references that were wiped when the DB was reset
 * (every Secret.externalId is "REPLACE_ME"). For each client we:
 *   1. find its `\Clients\<name> !CORE###!` folder in Secret Server (by CORE id, then by name),
 *   2. enumerate the folder's secrets (names/templates only — no values),
 *   3. classify them onto the logical secret slots the client's systems reference
 *      (lib/secrets/recovery-match.ts), pick the best candidate per slot,
 *   4. VERIFY the pick the way the app's "Test" does — resolve it from Delinea (read access) and
 *      check its field shape (lib/secrets/field-requirements.ts),
 *   5. persist externalId + the client's delineaFolderId,
 *   6. write a per-client / per-slot CSV report.
 *
 *   npx tsx scripts/recover-delinea-creds.ts            # DRY RUN — classify + verify, write CSV, no DB writes
 *   npx tsx scripts/recover-delinea-creds.ts --apply    # also persist externalId + delineaFolderId
 *   npx tsx scripts/recover-delinea-creds.ts --apply --llm   # let the Azure LLM break genuine ties
 *   npx tsx scripts/recover-delinea-creds.ts --client=<slug|CORE###>   # limit to one client
 *
 * Needs DELINEA_BASE_URL/USER/PASSWORD (loaded from repo-root .env, web/.env, or --env=<path>).
 * Never prints or persists a secret VALUE; only ids/names/field-names appear anywhere.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  delineaConfigFromEnv,
  delineaConfigured,
  getDelineaToken,
  checkSecret,
  resolveSecretFields,
} from "../lib/secrets/delinea";
import { listAllFolders, listFolderSecrets, type SecretSearchRecord } from "../lib/secrets/delinea-search";
import { candidatesBySlot, parseClientFolderName, normalizeClientName, shouldAutofill, type Candidate } from "../lib/secrets/recovery-match";
import { checkFieldShape } from "../lib/secrets/field-requirements";
import { azureConfigFromEnv, azureConfigured, azureChatJson } from "../lib/generator/llm";

function loadEnvFiles(): void {
  const explicit = process.argv.find((a) => a.startsWith("--env="))?.slice("--env=".length);
  const candidates = [
    explicit && resolve(explicit),
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "..", ".env"),
    resolve(__dirname, "..", ".env"),
    resolve(__dirname, "..", "..", ".env"),
    resolve(__dirname, "..", "..", "env.env"),
  ].filter(Boolean) as string[];
  const seen = new Set<string>();
  for (const path of candidates) {
    if (seen.has(path)) continue;
    seen.add(path);
    let text: string;
    try { text = readFileSync(path, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || line.trim().startsWith("#")) continue;
      const key = m[1];
      if (process.env[key] !== undefined) continue;
      let val = m[2];
      const dq = val.match(/^"([^"]*)"/);
      const sq = val.match(/^'([^']*)'/);
      if (dq) val = dq[1];
      else if (sq) val = sq[1];
      else val = val.replace(/\s+#.*$/, "");
      process.env[key] = val.trim();
    }
  }
}
loadEnvFiles();

const APPLY = process.argv.includes("--apply");
const USE_LLM = process.argv.includes("--llm");
const ONLY = process.argv.find((a) => a.startsWith("--client="))?.slice("--client=".length);

const db = new PrismaClient();

// One row of the report — one logical secret slot for one client.
type ReportRow = {
  client: string;
  coreId: string;
  slug: string;
  slot: string;
  systemKeys: string;
  category: string;
  written: string;
  tier: string;
  chosenSecretId: string;
  chosenSecretName: string;
  templateName: string;
  folderPath: string;
  ambiguous: string;
  accessOk: string;
  fieldShape: string;
  missingFields: string;
  candidateCount: number;
  alternatives: string;
  note: string;
};

const csvCell = (v: unknown): string => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Category names line up with the buckets the report is asked for.
const CAT = {
  correct: "correct (high confidence, verified)",
  guessedRight: "guessed (lower confidence) — verified working",
  thinkRightBroken: "think right but NOT working (resolves, fields incomplete)",
  wrong: "populated but NOT resolvable (wrong id / no access)",
  noCandidate: "needs manual — no matching secret in the folder",
  unmatched: "needs manual — client folder not found in Delinea",
  discovered: "discovered in Delinea — no slot in the app (wire the system to use it)",
  suggested: "SUGGESTED, not written — confirm this is the right credential",
  staleOnly: "needs manual — only retired/prior-MSP candidates found",
} as const;

// Ask the LLM to choose among candidates for a slot, returning the chosen Delinea id or null. Only
// used for genuine ties; never overrides a clean high-confidence pick. Fails soft to heuristic.
async function llmPick(clientName: string, slot: string, cands: Candidate[]): Promise<{ id: string; why: string } | null> {
  const cfg = azureConfigFromEnv();
  if (!azureConfigured(cfg)) return null;
  const menu = cands.slice(0, 8).map((c) => ({ id: String(c.record.id), name: c.record.name, template: c.record.secretTemplateName ?? "", folder: c.record.folderPath, stale: c.stale }));
  const sys = "You match a Delinea Secret Server credential to an automation integration slot for an IAM platform. Pick the ONE secret that is the ACTIVE service/API credential for the named integration. Prefer non-stale, automation/API credentials in an 'Identity Services' folder. Reply as JSON: {\"id\":\"<secret id or empty>\",\"why\":\"<short reason>\"}. Empty id if none fit.";
  const user = `Client: ${clientName}\nIntegration slot: ${slot}\nCandidate secrets (names only, no values):\n${JSON.stringify(menu, null, 2)}`;
  const res = await azureChatJson(cfg, sys, user, 200);
  const id = res && typeof res.id === "string" ? res.id.trim() : "";
  if (!id || !cands.some((c) => String(c.record.id) === id)) return null;
  return { id, why: typeof res?.why === "string" ? res.why : "llm pick" };
}

async function main() {
  const cfg = delineaConfigFromEnv();
  if (!delineaConfigured(cfg)) {
    console.error("✗ Delinea not configured — set DELINEA_BASE_URL/USER/PASSWORD.");
    process.exit(1);
  }
  console.log(`Mode: ${APPLY ? "APPLY (will write to DB)" : "DRY RUN (no DB writes)"}${USE_LLM ? " + LLM tiebreak" : ""}`);
  const token = await getDelineaToken(cfg);
  const fetcher = undefined; // real fetch

  // 1. All client folders under \Clients with a CORE tag.
  console.log("Listing Delinea folders…");
  const folders = await listAllFolders(cfg, token);
  const clientFolders = folders
    .map((f) => ({ f, parsed: parseClientFolderName(f.folderName) }))
    .filter((x) => x.parsed && /^\\Clients\\/i.test(x.f.folderPath));
  const byCore = new Map<string, { id: number; folderPath: string; folderName: string }>();
  const byName = new Map<string, { id: number; folderPath: string; folderName: string }>();
  for (const { f, parsed } of clientFolders) {
    byCore.set(parsed!.coreId.toUpperCase(), { id: f.id, folderPath: f.folderPath, folderName: f.folderName });
    byName.set(normalizeClientName(parsed!.displayName), { id: f.id, folderPath: f.folderPath, folderName: f.folderName });
  }
  console.log(`  ${folders.length} folders total, ${clientFolders.length} client folders with a CORE tag.`);

  // 2. Clients (with their needed secret slots + system references).
  const where = ONLY ? { OR: [{ slug: ONLY }, { coreId: ONLY.toUpperCase() }] } : { archivedAt: null };
  const clients = await db.client.findMany({
    where,
    select: {
      id: true, slug: true, name: true, coreId: true, primaryDomain: true, emailDomain: true, delineaFolderId: true,
      secrets: { select: { name: true, externalId: true } },
      systems: { select: { systemKey: true, secretNames: true } },
    },
    orderBy: { name: "asc" },
  });
  console.log(`Recovering ${clients.length} client(s).\n`);

  const rows: ReportRow[] = [];
  let filled = 0, verified = 0, suggested = 0;

  for (const client of clients) {
    if (client.secrets.length === 0) continue; // no secret slots to recover
    const systemKeysForSlot = (slot: string) =>
      client.systems.filter((s) => (s.secretNames ?? []).includes(slot)).map((s) => s.systemKey).sort().join(" ");

    // Match the folder.
    const folder =
      (client.coreId && byCore.get(client.coreId.toUpperCase())) ||
      byName.get(normalizeClientName(client.name)) ||
      null;

    if (!folder) {
      for (const sec of client.secrets) {
        rows.push(blankRow(client, sec.name, systemKeysForSlot(sec.name), CAT.unmatched, "no folder matched by CORE id or name"));
      }
      console.log(`— ${client.name} (${client.coreId ?? "no core id"}): folder NOT found`);
      continue;
    }

    // Enumerate + classify the folder's secrets.
    let records: SecretSearchRecord[];
    try {
      records = await listFolderSecrets(cfg, folder.id, token, fetcher);
    } catch (e) {
      for (const sec of client.secrets) rows.push(blankRow(client, sec.name, systemKeysForSlot(sec.name), CAT.unmatched, `folder list failed: ${(e as Error).message}`));
      console.log(`— ${client.name}: folder ${folder.id} list FAILED — ${(e as Error).message}`);
      continue;
    }
    const bySlot = candidatesBySlot(records);
    const clientHasTenantHint = Boolean(client.emailDomain || client.primaryDomain);

    const picks: { name: string; externalId: string }[] = [];
    for (const sec of client.secrets) {
      const slot = sec.name;
      const systemKeys = systemKeysForSlot(slot);
      const cands = bySlot.get(slot) ?? [];
      const live = cands.filter((c) => !c.stale);

      if (cands.length === 0) {
        rows.push(blankRow(client, slot, systemKeys, CAT.noCandidate, records.length ? `${records.length} secrets in folder, none matched ${slot}` : "folder empty / no read access"));
        continue;
      }
      // Only retired/prior-MSP candidates: never written unattended — surface them for a human.
      if (live.length === 0) {
        const best = cands[0];
        rows.push({
          ...blankRow(client, slot, systemKeys, CAT.staleOnly, `only stale candidates, best: "${best.record.name}"`),
          tier: best.tier,
          chosenSecretId: String(best.record.id),
          chosenSecretName: best.record.name,
          templateName: best.record.secretTemplateName ?? "",
          folderPath: best.record.folderPath,
          candidateCount: cands.length,
          alternatives: cands.slice(1, 4).map((c) => `${c.record.id}:${c.record.name}`).join(" | "),
        });
        continue;
      }
      const pool = live;

      let chosen = pool[0];
      let tier = chosen.tier as string;
      // LLM tiebreak only when the top two are close: same tier AND (ambiguous OR another same-tier live candidate).
      const contenders = pool.filter((c) => c.tier === chosen.tier && !c.stale);
      if (USE_LLM && (chosen.ambiguous || contenders.length > 1)) {
        const pick = await llmPick(client.name, slot, pool);
        if (pick) {
          const match = pool.find((c) => String(c.record.id) === pick.id);
          if (match) { chosen = match; tier = "llm"; }
        }
      }

      // Verify like the app's Test does: read access (metadata) + field shape (values, not shown).
      const access = await checkSecret(cfg, String(chosen.record.id), fetcher, token);
      let fieldOk: boolean | null = null;
      let missing: string[] = [];
      if (access.ok) {
        const resolved = await resolveSecretFields(cfg, String(chosen.record.id), fetcher, token);
        if (resolved.ok && resolved.fields) {
          const shape = checkFieldShape(slot, Object.keys(resolved.fields), { clientHasTenantHint });
          fieldOk = shape.ok;
          missing = shape.missing;
        } else {
          fieldOk = null; // resolved failed even though summary worked — treat as unknown shape
        }
      }

      const isVerified = access.ok && fieldOk !== false;
      // Write policy: a wrong-but-resolvable credential shows green and fails in production, so a
      // medium-confidence pick is only persisted for cloud systems that fail closed (never ad-dc).
      const write = shouldAutofill(chosen, isVerified);

      const category = !write
        ? CAT.suggested
        : !access.ok
        ? CAT.wrong
        : fieldOk === false
        ? CAT.thinkRightBroken
        : tier === "high"
        ? CAT.correct
        : CAT.guessedRight;

      if (write) {
        filled++;
        if (isVerified) verified++;
        picks.push({ name: slot, externalId: String(chosen.record.id) });
      } else {
        suggested++;
      }

      rows.push({
        client: client.name,
        coreId: client.coreId ?? "",
        slug: client.slug,
        slot,
        systemKeys,
        category,
        written: write ? (APPLY ? "yes" : "would") : "no",
        tier,
        chosenSecretId: String(chosen.record.id),
        chosenSecretName: chosen.record.name,
        templateName: chosen.record.secretTemplateName ?? "",
        folderPath: chosen.record.folderPath,
        ambiguous: chosen.ambiguous ? "yes" : "",
        accessOk: access.ok ? "ok" : `FAIL: ${access.error ?? ""}`,
        fieldShape: fieldOk === null ? "unknown" : fieldOk ? "ok" : "incomplete",
        missingFields: missing.join("; "),
        candidateCount: cands.length,
        alternatives: pool.slice(1, 4).map((c) => `${c.record.id}:${c.record.name}${c.stale ? " (stale)" : ""}`).join(" | "),
        note: chosen.reason,
      });
    }

    // Integration credentials sitting in the folder that the app has NO slot for (e.g. an
    // "S1_API integration" secret on a client with no sentinelone system). Not an error and not
    // written — a real credential the platform can't use until the system is wired on the client.
    // Only high-confidence live candidates, to keep this signal and not noise.
    const wantedSlots = new Set(client.secrets.map((s) => s.name));
    for (const [slot, cands] of bySlot) {
      if (wantedSlots.has(slot)) continue;
      const best = cands.find((c) => !c.stale && c.tier === "high" && !c.ambiguous);
      if (!best) continue;
      rows.push({
        ...blankRow(client, slot, "", CAT.discovered, `folder has "${best.record.name}" but no system on this client references the ${slot} secret`),
        tier: best.tier,
        chosenSecretId: String(best.record.id),
        chosenSecretName: best.record.name,
        templateName: best.record.secretTemplateName ?? "",
        folderPath: best.record.folderPath,
        candidateCount: cands.length,
      });
    }

    // Persist.
    if (APPLY) {
      if (folder.id && String(folder.id) !== client.delineaFolderId) {
        await db.client.update({ where: { id: client.id }, data: { delineaFolderId: String(folder.id) } });
      }
      for (const p of picks) {
        await db.secret.update({ where: { clientId_name: { clientId: client.id, name: p.name } }, data: { externalId: p.externalId } });
      }
    }
    const okCount = picks.length;
    console.log(`✓ ${client.name} (${client.coreId ?? "?"}): folder ${folder.id}, ${records.length} secrets, filled ${okCount}/${client.secrets.length} slot(s)`);
  }

  // 3. Report.
  const header = ["client","coreId","slug","slot","systemKeys","category","written","tier","chosenSecretId","chosenSecretName","templateName","folderPath","ambiguous","accessOk","fieldShape","missingFields","candidateCount","alternatives","note"];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push([r.client,r.coreId,r.slug,r.slot,r.systemKeys,r.category,r.written,r.tier,r.chosenSecretId,r.chosenSecretName,r.templateName,r.folderPath,r.ambiguous,r.accessOk,r.fieldShape,r.missingFields,r.candidateCount,r.alternatives,r.note].map(csvCell).join(","));
  }
  const outPath = resolve(process.cwd(), "delinea-cred-recovery-report.csv");
  writeFileSync(outPath, lines.join("\n") + "\n", "utf8");

  // Summary by category.
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
  console.log(`\n=== Summary (${rows.length} slots across ${clients.length} clients) ===`);
  for (const [cat, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n.toString().padStart(4)}  ${cat}`);
  console.log(`\nFilled ${filled} slot(s), ${verified} of them verified (read + field shape); ${suggested} suggested for human confirmation. ${APPLY ? "Written to DB." : "DRY RUN — nothing written."}`);
  console.log(`Report: ${outPath}`);
  await db.$disconnect();
}

function blankRow(client: { name: string; coreId: string | null; slug: string }, slot: string, systemKeys: string, category: string, note: string): ReportRow {
  return {
    client: client.name, coreId: client.coreId ?? "", slug: client.slug, slot, systemKeys, category,
    written: "no",
    tier: "", chosenSecretId: "", chosenSecretName: "", templateName: "", folderPath: "", ambiguous: "",
    accessOk: "", fieldShape: "", missingFields: "", candidateCount: 0, alternatives: "", note,
  };
}

main().catch((e) => { console.error("✗", e instanceof Error ? e.stack : e); process.exit(1); });
