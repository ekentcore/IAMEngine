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
// `entra` is the same executor as `m365` (an alias), so it is the natural "later" lane.
//
// HAS-EXCHANGE-STEP PRECONDITION (2026-07-16): a client with NO exchange offboard step gets NO
// removeLicense at all. The runtime guard (mailboxConvertPending/mailboxConverted) only exists when
// the app finds an exchange step in the plan to derive it from — with no exchange step the keys are
// never injected, the guard can never fire, and an unguarded removeLicense purges the unconverted
// mailbox with no warning (this shipped to 11 live clients before the precondition existed). Those
// clients are listed as BLOCKED/WITHHELD until an exchange step exists or the client opts out via
// removeLicense.allowWithoutConvert.
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
// Kept for reporting only — it no longer decides whether we convert. See CONVERT BY DEFAULT below.
const MENTIONS_SHARED = /shared mailbox|convert .{0,25}shared|to a shared/i;

// CONVERT BY DEFAULT (2026-07-16).
//
// Conversion used to be gated on the runbook MENTIONING a shared mailbox, on the principle of not
// inventing policy for a client. But the licence lane was NOT gated the same way: `licenceLane` chose
// `entra` whenever an entra lane and an exchange step both existed, regardless. So a client whose
// runbook says "remove the licence" and never mentions a shared mailbox — Easterseals, and 54 others
// — had its licence removal deferred behind a conversion that was never configured. The Entra step
// then refuses to strip a licence off an unconverted mailbox (correctly: Exchange purges it after the
// 30-day grace), and the licence is stranded FOREVER. Every offboard for those 55 ended with
// "license KEPT", still billing — the exact cost this sweep exists to reclaim, in its worst form:
// seat retained AND nothing converted.
//
// The deadlock has no good resolution at config level, because the two options are not symmetric:
//   - convert, then remove   -> seat reclaimed AND the mail kept. A shared mailbox under 50GB needs
//                              no licence, so this costs nothing.
//   - remove without convert -> seat reclaimed, mail PURGED after 30 days. Irreversible.
// A runbook that says "remove the licence" and stops is not choosing the second — it predates anyone
// thinking about the mailbox at all. Doing exactly what it says destroys the leaver's mail.
//
// So: any client whose licence we remove now also converts, unless the client explicitly opts out via
// `removeLicense.allowWithoutConvert` (see the runner's guard). Not inventing policy — choosing the
// non-destructive reading of a runbook that didn't say, and leaving an explicit way to say otherwise.
const CONVERT_BY_DEFAULT = true;

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

// Say it OUT LOUD when the drafts are unreadable: runbook intent (wantsLicence/wantsShared) all reads
// false then, so the sweep can only run its config-driven repairs. A silent no-op here once read as
// "fleet clean" over live destructive config.
try { readdirSync(DRAFTS); } catch {
  console.error(`WARNING: runbook drafts not readable at ${DRAFTS} — intent cannot be derived, so nothing new will be configured.`);
  console.error(`         Config-driven repairs (stripping unguarded removeLicense) still run. Pass --drafts=<path> for the full sweep.\n`);
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
  const mentionsShared = rb ? MENTIONS_SHARED.test(rb) : false;
  // Convert whenever we take the licence off. A client that has explicitly opted out
  // (removeLicense.allowWithoutConvert) keeps its own answer — the override exists to be respected,
  // and a sweep that overwrote it would just re-break the client on its next run.
  // Read the opt-out off the RAW entra row (anySys), not the offboard-enabled one: a flag recorded on
  // a row whose offboardWhen was later set to 'never' is still the client's answer, and missing it
  // here both clobbers the only record of it (the re-enable write replaces config wholesale) and
  // withholds a removal the client explicitly authorized.
  const optedOut = Boolean(
    ((m365.config ?? {}).offboard ?? {}).removeLicense?.allowWithoutConvert ||
    ((entraRow?.config ?? {}).offboard ?? {}).removeLicense?.allowWithoutConvert,
  );
  const wantsShared = optedOut ? false : (CONVERT_BY_DEFAULT ? wantsLicence : mentionsShared);
  const needsApproval = policy?.mode === "approval";
  const ob = (s) => ((s?.config ?? {}).offboard ?? null);
  // hasLicence must see the RAW entra row too: a disabled entra lane still carries config a re-enable
  // would resurrect, and the danger test below must not go blind to it.
  const hasLicence = Boolean(ob(m365)?.removeLicense || ob(entraRow)?.removeLicense);
  const hasConvert = Boolean(ob(exchange)?.convertToShared);

  // DANGEROUS CONFIG IS REPAIRED UNCONDITIONALLY. The strip of an unguarded removeLicense must never
  // depend on the runbook drafts being present/matchable — a missing drafts dir made the whole repair
  // a silent no-op that printed "clients needing work: 0" over 11 live destructive configs. Evidence
  // gates what we ADD, never what we make safe.
  const dangerous = hasLicence && !exchange && !optedOut;
  if (!wantsLicence && !wantsShared && !dangerous) continue; // runbook asks for neither (or forbids it), nothing dangerous — leave alone
  // The defect this sweep created and now repairs: the licence may only move to the LATER lane when a
  // conversion is actually configured to happen there. Deferring it behind a conversion that will
  // never run is not caution, it is a deadlock — and it reads as caution in the log, which is why it
  // went unnoticed across 55 clients. With convert-by-default the two now move together by
  // construction; the guard stays so an opt-out client can never re-enter that state.
  // "Already correct" must ALSO mean no dependency cycle — exchange depending on entra while entra
  // depends on exchange deadlocks the plan, and that is not a state we may skip over.
  const cycle = Boolean(exchange && entra && exchange.dependsOn.includes("entra") && entra.dependsOn.includes("exchange"));
  // "Already correct" must ALSO mean the m365 row's own removeLicense (if any) is the defer marker or
  // an explicit opt-out — an early unguarded {} on m365 alongside a correct entra/exchange setup runs
  // FIRST and trips the convert-pending guard on every offboard forever.
  const m365rl = ob(m365)?.removeLicense;
  const m365LaneSafe = !m365rl || m365rl.defer === true || (m365rl.removedBy && m365rl.removedBy !== "m365") || m365rl.allowWithoutConvert === true;
  if (hasLicence && hasConvert && entra && entra.dependsOn.includes("exchange") && !cycle && m365LaneSafe) continue; // already correct

  // The lane that OWNS the licence removal. `entra` is the same executor as m365, and 108 clients
  // already carry it as an offboard-only lane — so when a client needs "licence AFTER the mailbox" but
  // has no entra row, CREATE one rather than leave the licence on m365 (which runs first, and would
  // then warn on every single offboard forever).
  const needsEntraLane = wantsLicence && wantsShared && exchange && !entra;   // create OR re-enable
  // `wantsShared` is the load-bearing term here and its absence WAS the bug: this read
  // `(entra || needsEntraLane) && exchange`, so a client with both lanes had its licence deferred to
  // entra even when nothing would ever convert. If we are not converting, the licence must stay on
  // m365, where the runtime guard can act on it — never parked behind a step that will never happen.
  const licenceLane = wantsShared && (entra || needsEntraLane) && exchange ? "entra" : "m365";
  plan.push({
    client: c, m365, exchange, entra, entraRow, licenceLane, policy, needsApproval, needsEntraLane,
    wantsLicence, wantsShared, hasLicence, hasConvert, optedOut,
    noRunbook: !rb,
    // HAS-EXCHANGE-STEP PRECONDITION: with no exchange offboard step in the plan, the app never
    // injects mailboxConverted/mailboxConvertPending onto the m365 job — so the runner's convert
    // guard NEVER fires and an unguarded removeLicense purges the unconverted mailbox with no
    // warning (this shipped to 11 live clients before the precondition existed). Licence removal
    // is WITHHELD for these clients until an exchange step exists or the client explicitly opts
    // out (removeLicense.allowWithoutConvert). `dangerous` (config present, evidence or not) is
    // part of the trigger so the repair runs even when the runbook drafts are unreadable.
    blockedNoExchange: (wantsLicence || dangerous) && !exchange && !optedOut,
    dangerous,
  });
}

// The invariant this sweep got wrong once, asserted before it writes anything: a licence parked on a
// LATER lane must have a conversion configured to happen there. Violating it strands the licence
// forever, and — because the step's warning reads like ordinary caution — silently. Checked here
// rather than trusted, since the whole class of bug is that nobody noticed for 55 clients.
const stranded = plan.filter((p) => p.wantsLicence && p.licenceLane === "entra" && !p.wantsShared);
if (stranded.length) {
  console.error(`REFUSING TO WRITE — ${stranded.length} client(s) would defer the licence to entra with no conversion configured, which strands it forever:`);
  for (const p of stranded) console.error(`  ${p.client.slug}  ${p.client.name}`);
  process.exit(1);
}

console.log(`clients needing work: ${plan.length}\n`);
let applied = 0;
const reorder = [];

for (const p of plan) {
  const { client: c, m365, exchange, entra, licenceLane } = p;
  const writes = [];
  // A client we know is DANGEROUS but whose runbook we could not read gets repaired and NOTHING else:
  // writing containment defaults for a client whose intent is unreadable would be inventing policy.
  const stripOnly = p.dangerous && !p.wantsLicence && !p.wantsShared;

  // 1. m365 — containment. It owns the licence ONLY when there is no later lane.
  const m365cfg = { ...(m365.config ?? {}) };
  const m365ob = { ...((m365cfg.offboard ?? {})) };
  if (!stripOnly) {
    m365ob.blockSignIn = true;
    m365ob.removeAllGroups = true;
    m365ob.mailbox = { sizeThresholdGB: THRESHOLD_GB };
  }
  if (p.blockedNoExchange) {
    // No exchange offboard step => the app injects no mailboxConverted/-Pending keys => the runner's
    // convert guard cannot fire. An unguarded removeLicense here is silently destructive, so STRIP
    // it (repairing the 11 clients the previous sweep wrote it to) and leave the licence alone.
    delete m365ob.removeLicense;
  }
  else if (p.wantsLicence) {
    if (licenceLane === "entra") {
      m365ob.removeLicense = { defer: true, removedBy: "entra", note: "Removed in the Entra step, after the mailbox is converted to shared." };
    } else {
      // m365 owns the removal (the client opted out of converting). Keep the client's own keys —
      // clobbering with {} is what used to erase allowWithoutConvert — but DROP stale routing keys
      // (defer/removedBy/note) from an earlier entra-lane pass: leaving defer:true on the owning
      // lane strands the licence behind a step that will never run. And the opt-out must land HERE,
      // on the object the runner actually reads, even when it was recorded on the entra row.
      const prev = m365ob.removeLicense && typeof m365ob.removeLicense === "object" ? m365ob.removeLicense : {};
      const { defer: _defer, removedBy: _removedBy, note: _note, ...keep } = prev;
      if (p.optedOut) keep.allowWithoutConvert = true;
      m365ob.removeLicense = keep;
    }
  }
  m365cfg.offboard = m365ob;
  writes.push({ row: m365, data: { config: m365cfg } });

  // 1b. The entra row (enabled OR disabled) can carry its own removeLicense from an earlier pass. On a
  // blocked client it is just as unguarded as m365's — the withhold is a lie if it survives here.
  if (p.blockedNoExchange) {
    const enRow = p.entra ?? p.entraRow;
    if (enRow && ((enRow.config ?? {}).offboard ?? {}).removeLicense) {
      const enCfg = { ...(enRow.config ?? {}) };
      const enOb = { ...((enCfg.offboard ?? {})) };
      delete enOb.removeLicense;
      enCfg.offboard = enOb;
      writes.push({ row: enRow, data: { config: enCfg } });
    }
  }

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

  if (p.blockedNoExchange) reorder.push(c.slug);
  let tag = p.blockedNoExchange ? "  [BLOCKED: no exchange offboard step — licence removal withheld (guard can't fire without one)]" : "";
  if (stripOnly) tag += "  [runbook unreadable — strip only, nothing new configured]";
  if (p.needsEntraLane) tag += "  [+creates the entra lane]";
  if (p.needsApproval) tag += "  [approval-gated]";
  if (p.policy) tag += `  [POLICY: ${p.policy.why}]`;
  const what = p.blockedNoExchange ? "licence removal WITHHELD" : p.wantsLicence ? `licence->${licenceLane}` : "NO licence removal";
  console.log(`${c.slug.padEnd(18)} ${c.name.slice(0, 36).padEnd(38)} ${what}${p.wantsShared && exchange ? " +convert" : ""}${tag}`);

  if (APPLY) {
    for (const w of writes) {
      if (w.create) await db.clientSystem.create({ data: w.create });
      else await db.clientSystem.update({ where: { id: w.row.id }, data: w.data });
    }
    applied++;
  }
}

console.log(`\n${APPLY ? `APPLIED to ${applied} client(s).` : "dry run — nothing written. Re-run with --apply."}`);
if (reorder.length) console.log(`licence removal WITHHELD — no exchange offboard step, so the convert guard can never fire.\nAdd an exchange step (or an explicit removeLicense.allowWithoutConvert opt-out) and re-run: ${reorder.join(", ")}`);
if (APPLY && applied) {
  // Job.request.config is snapshotted at PLAN time — this sweep changes ClientSystem only, so a case
  // planned BEFORE it still carries the old config and runs with it. The repair is not complete until
  // those are re-planned; saying so here is the difference between "fixed" and "looks fixed".
  console.log(`\nNOTE: already-planned cases still carry the OLD config in their job snapshots (config is copied at PLAN time).`);
  console.log(`      RE-PLAN any open offboard case for the clients above, or the sweep changes won't apply to it.`);
}
await db.$disconnect();
