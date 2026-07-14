#!/usr/bin/env node
// FLEET SWEEP — offboard licence removal + shared-mailbox conversion.
//
// What the sweep found (2026-07-14): of 134 clients with a 365 offboard step, only SIX removed the
// leaver's licence or converted their mailbox. 203 of 230 runbooks say to remove the licence. So for
// ~128 clients we have been blocking sign-in and then leaving a licensed, un-converted mailbox behind
// — the seat is never reclaimed and the runbook step silently never ran (this is the BayPine bug,
// fleet-wide: the profile generator produced the STEPS but never the CONFIG).
//
// And of the six that were configured, most had the licence coming off in a step that runs BEFORE
// Exchange converts the mailbox — which is destructive: Exchange purges an unlicensed, unconverted
// mailbox once its 30-day grace expires.
//
// The order this enforces, per client:
//     m365      block sign-in, revoke sessions, remove groups     (containment first)
//     exchange  convert the mailbox to SHARED (skipped over 50GB)
//     entra     remove the licence        <- dependsOn: [exchange]
//
// `entra` is the same executor as `m365` (an alias), so it is the natural "later" lane. A client with
// no entra lane keeps the licence removal on m365 and relies on the runtime guard (mailboxConvertPending)
// to keep it safe — it warns instead of destroying the mailbox, and is listed below as NEEDS-REORDER.
//
// EVIDENCE-DRIVEN: a client only gets `removeLicense` if its runbook asks for it, and `convertToShared`
// if its runbook mentions a shared mailbox. We do not invent policy for a client.
//
// Usage:  node scripts/offboard-license-sweep.mjs            (dry run — prints the plan, writes nothing)
//         node scripts/offboard-license-sweep.mjs --apply     (writes)
//         node scripts/offboard-license-sweep.mjs --only=regal,yuma,six-one
import { PrismaClient } from "@prisma/client";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const db = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) ?? "").replace("--only=", "").split(",").filter(Boolean);
// The runbook drafts are NOT in git (they're extraction artefacts), so the path is overridable —
// in a worktree they only exist back in the main checkout.
const DRAFTS = (process.argv.find((a) => a.startsWith("--drafts=")) ?? "").replace("--drafts=", "")
  || join(process.cwd(), "..", "profiles", "_drafts");
const THRESHOLD_GB = 50;

// --- what does this client's RUNBOOK actually ask for? -------------------------------------------
const WANTS_LICENCE = /remove .{0,30}licen|licen.{0,30}remov|reclaim .{0,20}licen/i;
const WANTS_SHARED = /shared mailbox|convert .{0,25}shared|to a shared/i;

// EXPLICIT POLICY, read off the runbooks by hand. A regex can't tell "remove the license" from
// "do NOT remove the license" — and three clients say exactly that. Never let the sweep decide these.
//   never    — the runbook forbids it outright. No licence removal, at all.
//   approval — the runbook requires written sign-off; it stays automated but the step is approval-gated.
const LICENCE_POLICY = {
  // "NOTE: Do NOT remove the license."
  core1387: { mode: "never", why: "runbook: 'NOTE: Do NOT remove the license.'" },
  // "Do NOT remove the user's licenses from the account without written approval"
  "the-fitzpatrick-group": { mode: "approval", why: "runbook: licences need written approval" },
  // "Do not remove the license yet" — i.e. not in the 365 step; after the mailbox is dealt with. That
  // is precisely the deferred lane this sweep sets up, so it needs no override beyond a note.
  core507: { mode: "defer-only", why: "runbook: 'Do not remove the license yet'" },
};

function runbookText(slug, name) {
  // Drafts are named after the client, not the slug — match on a normalised name.
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  let files = [];
  try { files = readdirSync(DRAFTS).filter((f) => f.endsWith(".runbook.json")); } catch { return null; }
  const target = norm(name);
  const hit = files.find((f) => {
    const base = norm(f.replace(".runbook.json", ""));
    return base && (target.startsWith(base) || base.startsWith(target));
  });
  if (!hit) return null;
  try { return JSON.stringify(JSON.parse(readFileSync(join(DRAFTS, hit), "utf8"))); } catch { return null; }
}

const clients = await db.client.findMany({
  select: { id: true, slug: true, name: true, systems: { select: { id: true, systemKey: true, dependsOn: true, config: true, offboardWhen: true, secretNames: true } } },
  orderBy: { slug: "asc" },
});

const plan = [];
for (const c of clients) {
  if (ONLY.length && !ONLY.includes(c.slug)) continue;
  const sys = (k) => c.systems.find((s) => s.systemKey === k && s.offboardWhen !== "never");
  const anySys = (k) => c.systems.find((s) => s.systemKey === k);
  const m365 = sys("m365"), exchange = sys("exchange");
  // An entra row may EXIST but be switched off for offboard (offboardWhen: 'never'). That is not a
  // missing lane — creating a second one violates the (clientId, systemKey) unique key. Re-enable it.
  const entraRow = anySys("entra");
  const entra = sys("entra");
  if (!m365) continue; // no 365 offboard at all — nothing to do

  const rb = runbookText(c.slug, c.name);
  const policy = LICENCE_POLICY[c.slug] ?? null;
  // A hand-read "do NOT remove the licence" always beats the regex.
  const wantsLicence = policy?.mode === "never" ? false : (rb ? WANTS_LICENCE.test(rb) : false);
  const wantsShared = rb ? WANTS_SHARED.test(rb) : false;
  const needsApproval = policy?.mode === "approval";
  const ob = (s) => ((s?.config ?? {}).offboard ?? null);
  const hasLicence = Boolean(ob(m365)?.removeLicense || ob(entra)?.removeLicense);
  const hasConvert = Boolean(ob(exchange)?.convertToShared);

  if (!wantsLicence && !wantsShared) continue;          // runbook asks for neither (or forbids it) — leave alone
  // "Already correct" must ALSO mean no dependency cycle — exchange depending on entra while entra
  // depends on exchange deadlocks the plan, and that is not a state we may skip over.
  const cycle = Boolean(exchange && entra && exchange.dependsOn.includes("entra") && entra.dependsOn.includes("exchange"));
  if (hasLicence && hasConvert && entra && entra.dependsOn.includes("exchange") && !cycle) continue; // already correct

  // The lane that OWNS the licence removal. `entra` is the same executor as m365, and 108 clients
  // already carry it as an offboard-only lane — so when a client needs "licence AFTER the mailbox" but
  // has no entra row, CREATE one rather than leave the licence on m365 (which runs first, and would
  // then warn on every single offboard forever).
  const needsEntraLane = wantsLicence && wantsShared && exchange && !entra;   // create OR re-enable
  const licenceLane = (entra || needsEntraLane) && exchange ? "entra" : "m365";
  plan.push({
    client: c, m365, exchange, entra, entraRow, licenceLane, policy, needsApproval, needsEntraLane,
    wantsLicence, wantsShared, hasLicence, hasConvert,
    noRunbook: !rb,
    // Only left on m365 when there is no exchange step to order against at all.
    needsReorder: wantsShared && wantsLicence && !exchange,
  });
}

console.log(`clients needing work: ${plan.length}\n`);
let applied = 0;
const reorder = [];

for (const p of plan) {
  const { client: c, m365, exchange, entra, licenceLane } = p;
  const writes = [];

  // 1. m365 — containment. It owns the licence ONLY when there is no later lane.
  const m365cfg = { ...(m365.config ?? {}) };
  const m365ob = { ...((m365cfg.offboard ?? {})) };
  m365ob.blockSignIn = true;
  m365ob.removeAllGroups = true;
  m365ob.mailbox = { sizeThresholdGB: THRESHOLD_GB };
  if (p.wantsLicence) {
    m365ob.removeLicense = licenceLane === "entra"
      ? { defer: true, removedBy: "entra", note: "Removed in the Entra step, after the mailbox is converted to shared." }
      : {};   // no later lane — the runtime guard protects the ordering
  }
  m365cfg.offboard = m365ob;
  writes.push({ row: m365, data: { config: m365cfg } });

  // 2. exchange — convert to shared, when the runbook asks for it.
  if (p.wantsShared && exchange) {
    const exCfg = { ...(exchange.config ?? {}) };
    exCfg.offboard = { ...((exCfg.offboard ?? {})), convertToShared: { skipIfMailboxOverGB: THRESHOLD_GB } };
    const exData = { config: exCfg };
    // CYCLE GUARD: we are about to make entra depend on exchange. If exchange currently depends on
    // entra (Yuma did), that is a circular dependency and NEITHER step's gate could ever open — the
    // offboard would deadlock. Repoint exchange at m365, which is what the rest of the fleet does.
    if (licenceLane === "entra" && exchange.dependsOn.includes("entra")) {
      exData.dependsOn = exchange.dependsOn.filter((d) => d !== "entra");
      if (!exData.dependsOn.length) exData.dependsOn = ["m365"];
    }
    writes.push({ row: exchange, data: exData });
  }

  // 3. entra — the licence comes off HERE, and only after exchange has succeeded.
  if (p.wantsLicence && licenceLane === "entra" && p.needsEntraLane) {
    // Mirror the fleet's standard offboard-only entra lane (108 clients already look exactly like this).
    const enOb = { removeLicense: {}, mailbox: { sizeThresholdGB: THRESHOLD_GB } };
    const cfg = { intent: { offboard: "disable" }, onboard: null, offboard: enOb, dependsOn: {},
                  captureEvidence: { onboard: false, offboard: false },
                  requiresApproval: { onboard: false, offboard: Boolean(p.needsApproval) } };
    if (p.entraRow) {
      // The row exists but its offboard lane is switched off — turn it on, don't duplicate it.
      writes.push({ row: p.entraRow, data: { offboardWhen: "always", mode: "api", dependsOn: ["exchange"],
                                             requiresApproval: Boolean(p.needsApproval),
                                             config: { ...(p.entraRow.config ?? {}), offboard: enOb },
                                             secretNames: (p.entraRow.secretNames?.length ? p.entraRow.secretNames : (m365.secretNames ?? ["m365-admin"])) } });
    } else {
      writes.push({ create: {
        clientId: c.id, systemKey: "entra", mode: "api",
        onboardWhen: "never", offboardWhen: "always",
        dependsOn: ["exchange"], requiresApproval: Boolean(p.needsApproval), captureEvidence: false,
        secretNames: m365.secretNames ?? ["m365-admin"], config: cfg,
      } });
    }
  }
  else if (p.wantsLicence && licenceLane === "entra") {
    const enCfg = { ...(entra.config ?? {}) };
    enCfg.offboard = { ...((enCfg.offboard ?? {})), removeLicense: {}, mailbox: { sizeThresholdGB: THRESHOLD_GB } };
    const dependsOn = p.wantsShared ? ["exchange"] : entra.dependsOn;
    // "…without written approval" => a human releases the step; it never fires unattended.
    const data = { config: enCfg, dependsOn };
    if (p.needsApproval) data.requiresApproval = true;
    writes.push({ row: entra, data });
  }

  if (p.needsReorder) reorder.push(c.slug);
  let tag = p.needsReorder ? "  [no exchange step — licence on m365, runtime guard protects it]" : "";
  if (p.needsEntraLane) tag += "  [+creates the entra lane]";
  if (p.needsApproval) tag += "  [approval-gated]";
  if (p.policy) tag += `  [POLICY: ${p.policy.why}]`;
  const what = p.wantsLicence ? `licence->${licenceLane}` : "NO licence removal";
  console.log(`${c.slug.padEnd(18)} ${c.name.slice(0, 36).padEnd(38)} ${what}${p.wantsShared ? " +convert" : ""}${tag}`);

  if (APPLY) {
    for (const w of writes) {
      if (w.create) await db.clientSystem.create({ data: w.create });
      else await db.clientSystem.update({ where: { id: w.row.id }, data: w.data });
    }
    applied++;
  }
}

console.log(`\n${APPLY ? `APPLIED to ${applied} client(s).` : "dry run — nothing written. Re-run with --apply."}`);
if (reorder.length) console.log(`no entra lane (licence kept on m365, guarded at runtime): ${reorder.join(", ")}`);
await db.$disconnect();
