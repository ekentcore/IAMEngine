// Dispatch FR #88's "Correct user" / "Remove user" from an onboard case: one ad-hoc job per directory
// system the onboard actually ran (a line that succeeded — something exists there to fix or remove).
//
// WHICH account: each job carries config.target — the account that system's onboard (or its latest
// SUCCEEDED correction) reported, with its immutable id where the result has one (resolveTarget). The
// payload's username is only the fallback, because the onboard may have created a fallback username
// when the primary belonged to someone else. The runner matches on the id when it has one; otherwise it
// acts only on an account provably created for this case (created no earlier than config.caseCreatedAt).
//
// Remove is destructive by definition: every job is approval-gated with an evidence snapshot, names the
// account it will delete (config.approvalTarget, shown to the approver), and is only offered while the
// onboard is recent (REMOVE_USER_WINDOW_DAYS).
//
// Correct is not gated — it renames, it doesn't delete. The case payload is NOT changed at dispatch:
// the corrected values ride on the jobs (config) under one correctionId, and
// commitUserCorrectionIfComplete writes them to the case only once every job of that correction has
// succeeded. Correct is refused once a Remove has succeeded on the case.
import { randomUUID } from "node:crypto";
import type { PrismaClient, Prisma, JobStatus } from "@prisma/client";
import { insertStepSequence } from "../jobs/adhoc";
import {
  REMOVE_USER_KEY, CORRECT_USER_KEY, REMOVE_USER_WINDOW_DAYS, USER_ADHOC_SYSTEM_KEYS, CORRECT_USER_SYSTEM_KEYS, REMOVE_USER_SYSTEM_KEYS,
  TARGET_SYSTEM_OF, identityOf, correctedPayload, resolveTarget, describeTarget, type UserCorrection,
  preexistingAccounts, removeDeletedSomething, AD_USER_ADHOC_KEYS, userAdhocVersionExclusions, USER_ADHOC_MIN_RUNNER,
} from "../jobs/user-adhoc";
import { adUpnFor, STANDALONE } from "../profiles/ad-domain";
import { parseCapabilities, onPremExclusions } from "../runner/capabilities";
import { resolveActor, type ActorInput } from "../auth/actor";

export type UserAdhocResult =
  | { ok: true; jobs: { id: string; systemKey: string }[] }
  | { ok: false; status: number; error: string };

const RAN = "succeeded";
const IN_FLIGHT: JobStatus[] = ["pending", "dispatched", "running"];
// The mailbox lives in Exchange Online whenever the onboard ran an M365/Entra line — the m365 step's
// licence creates it, and the plan may have no separate exchange line at all.
const CLOUD_MAILBOX_SOURCES = ["m365", "entra"];
const SYNCED = new Set(["ad_synced", "ad-synced"]);

const configOf = (j: { request: unknown }) => ((((j.request ?? {}) as { config?: unknown }).config ?? {}) as Record<string, unknown>);

class Busy extends Error { constructor(public systemKey: string) { super("busy"); } }

export async function dispatchUserAdhoc(
  db: PrismaClient,
  caseId: string,
  kind: "remove" | "correct",
  actor: ActorInput,
  correction?: UserCorrection,
): Promise<UserAdhocResult> {
  const c = await db.caseRequest.findUnique({
    where: { id: caseId },
    select: {
      action: true, createdAt: true, dryRun: true, clientId: true, payload: true,
      client: { select: { backbone: true, identity: true } },
      jobs: { select: { id: true, systemKey: true, status: true, request: true, result: true, sequence: true } },
    },
  });
  if (!c) return { ok: false, status: 404, error: "case not found" };
  if (c.action !== "onboard") return { ok: false, status: 422, error: "only an onboard case can correct or remove the user it created" };
  if (c.dryRun) return { ok: false, status: 409, error: "this case is in dry-run mode — nothing was created, so there's nothing to correct or remove" };
  if (kind === "remove" && Date.now() - c.createdAt.getTime() > REMOVE_USER_WINDOW_DAYS * 86_400_000) {
    return { ok: false, status: 409, error: `"Remove user" is only offered for ${REMOVE_USER_WINDOW_DAYS} days after the onboard — offboard this user instead` };
  }
  // M2: once the account has been removed there is nothing to correct — and a correction's fallback
  // lookups must never land on whoever holds that name now. Only a Remove that actually DELETED
  // something counts (round 3, N2): a refused / not-found remove leaves the account live.
  if (kind === "correct" && removeDeletedSomething(c.jobs)) {
    return { ok: false, status: 409, error: "the user was removed on this case — there's no account left to correct" };
  }
  const map = kind === "remove" ? REMOVE_USER_KEY : CORRECT_USER_KEY;
  // One job per TARGET key (m365 and entra share one), from the first line of that system that ran.
  const sources = new Map<string, (typeof c.jobs)[number]>();
  for (const j of c.jobs) {
    const target = map[j.systemKey];
    if (!target || j.status !== RAN || sources.has(target)) continue;
    // A correction with no email change has nothing for Exchange to do.
    if (target === "exchange-correct-user" && !correction?.email) continue;
    sources.set(target, j);
  }
  const m365Target = resolveTarget("m365", c.jobs);
  // A cloud mailbox made by the m365 step (no exchange line on the plan) still has to move its primary
  // address — Graph can't set it. Queue the Exchange Online correction off the M365 line's credential,
  // but not where it can do nothing: a directory-synced user's mailbox is AD's (the AD step readdresses
  // it). The mailbox may legitimately not exist, or EXO may not be reachable with the client's cert —
  // that job reports a warning rather than failing the correction (mailboxOptional).
  let mailboxOptional = false;
  const synced = SYNCED.has(String(c.client?.backbone ?? "")) || m365Target?.syncEnabled === true;
  if (kind === "correct" && correction?.email && !sources.has("exchange-correct-user") && !synced) {
    const m = c.jobs.find((j) => CLOUD_MAILBOX_SOURCES.includes(j.systemKey) && j.status === RAN);
    if (m) { sources.set("exchange-correct-user", m); mailboxOptional = true; }
  }
  if (sources.size === 0) return { ok: false, status: 409, error: "no directory step on this case has run yet, so there's no account to act on" };

  const payload = (c.payload ?? {}) as Record<string, unknown>;
  // Round 3 (N1): a Remove hard-deletes and purges. An account that existed before this case (a rehire
  // adopted by the onboard, or an operator Adopt) holds someone's earlier history — it needs an offboard,
  // never a Remove. Refuse the whole Remove, naming which systems, rather than delete half of it.
  if (kind === "remove") {
    const pre = preexistingAccounts(c.jobs, payload, c.createdAt);
    if (pre.length) {
      return { ok: false, status: 409, error: `"Remove user" deletes only accounts this case created, and these existed before it (a rehire or an adopted account) — offboard the user instead: ${pre.join("; ")}` };
    }
  }
  // Round 3 (N3): the AD keys run on the client's own runner. If no enabled runner of the client can
  // claim them — none at all, none with the AD module (the on-prem capability gate), or all older than
  // the correct/remove executors — the job would sit pending forever and block every later
  // Correct/Remove on the case. Refuse now and say what to fix.
  const adKey = [...sources.keys()].find((k) => AD_USER_ADHOC_KEYS.includes(k));
  if (adKey) {
    const verb = kind === "remove" ? "remove" : "correct";
    const agents = await db.agent.findMany({ where: { clientId: c.clientId, enabled: true }, select: { name: true, semver: true, capabilities: true } });
    const capable = agents.filter((a) => !onPremExclusions(parseCapabilities(a.capabilities)).includes(adKey));
    if (capable.length === 0) {
      return { ok: false, status: 409, error: agents.length
        ? `none of the client's runners can run Active Directory steps (${agents.map((a) => a.name).join(", ")}), so it can't ${verb} the AD account — check the AD module on the client's runner`
        : `the client has no enabled runner, so it can't ${verb} the AD account — enable or install the client's runner first` };
    }
    if (capable.every((a) => userAdhocVersionExclusions(a.semver).length > 0)) {
      const list = capable.map((a) => `${a.name} (${a.semver ?? "version unknown"})`).join(", ");
      return { ok: false, status: 409, error: `the client's runner must be updated to ${USER_ADHOC_MIN_RUNNER} or later before it can ${verb} the AD account — ${list}` };
    }
  }
  const previousIdentity = identityOf(payload);
  const correctionId = kind === "correct" ? randomUUID() : null;
  const destructive = kind === "remove";
  const caseCreatedAt = c.createdAt.toISOString();
  // AD-standalone (FR #83/#107): AD has its own UPN suffix, separate from the mail domain. The AD lane
  // gets the corrected local part on THAT suffix — never the cloud domain — and looks the account up by
  // the AD UPN the onboard gave it (the same derivation the claim applies to on-prem lanes). Its mail /
  // proxyAddresses take the corrected CLOUD email (the AD-suffix UPN is never a mail address).
  const adNow = c.client ? adUpnFor(payload, c.client) : null;
  const standalone = STANDALONE.has(String(c.client?.backbone ?? ""));

  const configFor = (targetKey: string): Record<string, unknown> => {
    const system = TARGET_SYSTEM_OF[targetKey];
    const target = system ? resolveTarget(system, c.jobs, c.createdAt) : null;
    if (kind === "remove") {
      return { target, caseCreatedAt, approvalTarget: system ? describeTarget(system, target, payload) : null };
    }
    const newSam = correction?.email ? identityOf(correctedPayload(payload, correction)).SamAccountName : null;
    const cfg: Record<string, unknown> = {
      correctionId, correction, firstName: correction?.firstName, lastName: correction?.lastName, displayName: correction?.displayName,
      newUpn: correction?.email, newSam, previousIdentity, target, caseCreatedAt,
    };
    if (targetKey === "ad-correct-user" && adNow) {
      const adSuffix = adNow.upn.split("@")[1];
      cfg.previousIdentity = { ...previousIdentity, UserPrincipalName: adNow.upn };
      if (correction?.email) { cfg.newUpn = `${correction.email.split("@")[0]}@${adSuffix}`; cfg.adUpn = cfg.newUpn; }
    }
    if (targetKey === "ad-correct-user" && standalone && correction?.email) cfg.mailAddress = correction.email;
    if (targetKey === "exchange-correct-user" && mailboxOptional) cfg.mailboxOptional = true;
    return cfg;
  };
  // The Exchange correction runs on the central runner against Exchange Online only: a hybrid mailbox is
  // AD's to readdress (the AD step does it), so it must not try to open the client's on-prem session.
  const secretsFor = (targetKey: string, names: string[]) => (targetKey === "exchange-correct-user" ? names.filter((n) => n !== "exchange-onprem") : names);

  let jobs: { id: string; systemKey: string }[];
  try {
    jobs = await db.$transaction(async (tx) => {
      // L1: serialise dispatches on this case — lock the case row, THEN look for an in-flight
      // correct/remove. Two concurrent POSTs used to both pass a check made outside the transaction.
      await tx.$queryRaw`SELECT id FROM "CaseRequest" WHERE id = ${caseId} FOR UPDATE`;
      // ANY correct/remove job in flight blocks both kinds: a remove queued behind a pending correction
      // would race the rename, and two corrections at once would each commit over the other.
      const busy = await tx.job.findFirst({ where: { caseRequestId: caseId, systemKey: { in: USER_ADHOC_SYSTEM_KEYS }, status: { in: IN_FLIGHT } }, select: { systemKey: true } });
      if (busy) throw new Busy(busy.systemKey);
      const out: { id: string; systemKey: string }[] = [];
      for (const [targetKey, src] of sources) {
        const srcReq = (src.request ?? {}) as { secretNames?: string[] };
        const sequence = await insertStepSequence(tx, caseId);
        const j = await tx.job.create({
          data: {
            caseRequestId: caseId, systemKey: targetKey, mode: "api", sequence, status: "pending", singleRun: true,
            request: {
              secretNames: secretsFor(targetKey, srcReq.secretNames ?? []), config: configFor(targetKey), dependsOn: [],
              requiresApproval: destructive, captureEvidence: destructive, intent: destructive ? "destructive" : null,
            } as Prisma.InputJsonValue,
          },
          select: { id: true, systemKey: true },
        });
        out.push(j);
      }
      return out;
    });
  } catch (e) {
    if (e instanceof Busy) return { ok: false, status: 409, error: `a ${e.systemKey} step is already waiting or running on this case — let it finish (or approve it) first` };
    throw e;
  }

  const who = resolveActor(actor);
  await db.auditLog.create({
    data: {
      actor: who.actor, userId: who.userId, caseRequestId: caseId, clientId: c.clientId,
      action: kind === "remove" ? "case.user.remove_requested" : "case.user.correct_dispatched",
      detail: { jobs: jobs.map((j) => j.systemKey), ...(kind === "correct" ? { correction, previousIdentity, correctionId } : {}) } as Prisma.InputJsonValue,
    },
  });
  return { ok: true, jobs };
}

// Called from the job-result path when a correction job succeeds: once EVERY job of its correction
// (same correctionId) has succeeded, write the corrected identity to the case payload. Until then the
// case keeps the identity the account still has somewhere. Returns whether it committed.
export async function commitUserCorrectionIfComplete(db: PrismaClient, jobId: string): Promise<boolean> {
  const job = await db.job.findUnique({ where: { id: jobId }, select: { caseRequestId: true, systemKey: true, request: true } });
  if (!job || !CORRECT_USER_SYSTEM_KEYS.includes(job.systemKey)) return false;
  const cfg = configOf(job);
  const correctionId = typeof cfg.correctionId === "string" ? cfg.correctionId : null;
  const correction = (cfg.correction ?? null) as UserCorrection | null;
  if (!correctionId || !correction) return false;
  const c = await db.caseRequest.findUnique({
    where: { id: job.caseRequestId },
    select: { clientId: true, payload: true, jobs: { select: { id: true, systemKey: true, status: true, request: true } } },
  });
  if (!c) return false;
  const batch = c.jobs.filter((j) => CORRECT_USER_SYSTEM_KEYS.includes(j.systemKey) && configOf(j).correctionId === correctionId);
  if (batch.length === 0 || batch.some((j) => j.status !== RAN)) return false;
  const adJob = batch.find((j) => j.systemKey === "ad-correct-user");
  const adUpn = adJob && typeof configOf(adJob).adUpn === "string" ? String(configOf(adJob).adUpn) : null;
  const next = correctedPayload((c.payload ?? {}) as Record<string, unknown>, correction, { adUpn });
  await db.caseRequest.update({ where: { id: job.caseRequestId }, data: { payload: next as Prisma.InputJsonValue } });
  await db.auditLog.create({
    data: {
      actor: "system:user-correction", caseRequestId: job.caseRequestId, clientId: c.clientId, action: "case.user.correct_committed",
      detail: { correctionId, correction, jobs: batch.map((j) => j.systemKey) } as Prisma.InputJsonValue,
    },
  });
  return true;
}

// L3: may this finished correct/remove job be re-queued (re-run / run-single)? A correction is refused
// once a NEWER correction exists on the case (re-running A would revert the system and commit A over
// B). A remove gets a fresh 30-day window check and must be approved again — `patch` resets approval.
export async function userAdhocRequeueCheck(
  db: PrismaClient,
  job: { id: string; systemKey: string; caseRequestId: string; request: unknown },
): Promise<{ ok: true; patch?: Record<string, unknown>; drop?: string[] } | { ok: false; status: number; error: string }> {
  if (CORRECT_USER_SYSTEM_KEYS.includes(job.systemKey)) {
    const mine = configOf(job).correctionId;
    const others = await db.job.findMany({ where: { caseRequestId: job.caseRequestId, systemKey: { in: CORRECT_USER_SYSTEM_KEYS } }, select: { id: true, sequence: true, request: true } });
    const me = others.find((o) => o.id === job.id);
    const newer = others.some((o) => o.id !== job.id && configOf(o).correctionId !== mine && (o.sequence ?? 0) > (me?.sequence ?? 0));
    if (newer) return { ok: false, status: 409, error: "a newer correction exists on this case — re-running this older one would undo it. Dispatch a new correction instead" };
    return { ok: true };
  }
  if (REMOVE_USER_SYSTEM_KEYS.includes(job.systemKey)) {
    const c = await db.caseRequest.findUnique({ where: { id: job.caseRequestId }, select: { createdAt: true } });
    if (!c || Date.now() - c.createdAt.getTime() > REMOVE_USER_WINDOW_DAYS * 86_400_000) {
      return { ok: false, status: 409, error: `"Remove user" is only offered for ${REMOVE_USER_WINDOW_DAYS} days after the onboard — offboard this user instead` };
    }
    return { ok: true, patch: { approved: false, requiresApproval: true }, drop: ["approvedBy", "approvedAt"] };
  }
  return { ok: true };
}
