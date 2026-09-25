import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import { dispatchUserAdhoc, commitUserCorrectionIfComplete, userAdhocRequeueCheck } from "./user-adhoc-service";
import {
  checkCorrection, resolveTarget, removeConfirmKey, removalAccounts, userAdhocVersionExclusions, userAdhocResultStatus, USER_ADHOC_SYSTEM_KEYS, preexistingOf, preexistingAccounts, removeDeletedSomething,
} from "../jobs/user-adhoc";
import { adUpnFor } from "../profiles/ad-domain";
import { buildRunReport } from "./run-report";

type J = { id: string; systemKey: string; status: string; request: unknown; result?: unknown; sequence?: number };
// The onboard created a FALLBACK username for this hire: the payload says jsmyth (someone else's), the
// systems report jmsmyth with their immutable ids.
const DEFAULT_JOBS = (): J[] => [
  { id: "a", systemKey: "active-directory", status: "succeeded", sequence: 0, request: { secretNames: ["ad-dc"] }, result: { System: "active-directory", Sam: "jmsmyth", Upn: "jmsmyth@acme.com", ObjectGuid: "guid-1" } },
  { id: "m", systemKey: "m365", status: "succeeded", sequence: 1, request: { secretNames: ["m365-admin"] }, result: { System: "m365", UserId: "entra-1", Upn: "jmsmyth@acme.com", OnPremSyncEnabled: false } },
  { id: "e", systemKey: "entra", status: "succeeded", sequence: 2, request: { secretNames: ["m365-admin"] }, result: {} },
  { id: "x", systemKey: "exchange", status: "succeeded", sequence: 3, request: { secretNames: ["m365-admin"] }, result: {} },
  { id: "g", systemKey: "google-workspace", status: "pending", sequence: 4, request: {} },
];

// An in-memory case: dispatched jobs join the case's job list, so a later dispatch / commit sees them.
function stubDb(opts: { action?: string; ageDays?: number; jobs?: J[]; payload?: Record<string, unknown>; client?: { backbone: string | null; identity: unknown }; busyInTx?: string; agents?: Array<{ name: string; semver: string | null; capabilities?: unknown }> } = {}) {
  const created: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const raw: string[] = [];
  const state = {
    payload: opts.payload ?? ({ samAccountName: "jsmyth", userPrincipalName: "jsmyth@acme.com", displayName: "John Smyth" } as Record<string, unknown>),
    jobs: opts.jobs ?? DEFAULT_JOBS(),
  };
  const createdAt = new Date(Date.now() - (opts.ageDays ?? 1) * 86_400_000);
  const updateCase = async (args: { data: { payload: Record<string, unknown> } }) => { updates.push(args.data); state.payload = args.data.payload; return {}; };
  let seq = 100;
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray) => { raw.push(strings.join("?")); return []; },
    job: {
      // The in-transaction busy check: anything in flight among the correct/remove keys.
      findFirst: async (args: { where: { systemKey?: { in: string[] }; status?: { in: string[] } } }) => {
        if (opts.busyInTx) return { systemKey: opts.busyInTx };
        const keys = args.where.systemKey?.in; const sts = args.where.status?.in;
        const hit = keys && sts ? state.jobs.find((j) => keys.includes(j.systemKey) && sts.includes(j.status)) : null;
        return hit ? { systemKey: hit.systemKey } : null;
      },
      aggregate: async () => ({ _max: { sequence: 10 } }),
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
      create: async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        const id = `j${created.length}`;
        state.jobs.push({ id, systemKey: String(args.data.systemKey), status: "pending", request: args.data.request, sequence: seq++ });
        return { id, systemKey: args.data.systemKey };
      },
    },
    caseRequest: { update: updateCase },
  };
  const db = {
    caseRequest: {
      findUnique: async () => ({
        action: opts.action ?? "onboard", createdAt, dryRun: false, clientId: "c1",
        client: opts.client ?? { backbone: "entra", identity: {} },
        payload: state.payload,
        jobs: state.jobs,
      }),
      update: updateCase,
    },
    job: {
      findUnique: async (args: { where: { id: string } }) => { const j = state.jobs.find((x) => x.id === args.where.id); return j ? { caseRequestId: "case", ...j } : null; },
      findMany: async () => state.jobs,
    },
    agent: { findMany: async () => opts.agents ?? [{ name: "dc01", semver: "1.138.0" }] },
    $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
    auditLog: { create: async () => ({}) },
  } as unknown as PrismaClient;
  const finish = (systemKey: string, status: string, result?: unknown) => { const j = state.jobs.find((x) => x.systemKey === systemKey && x.status === "pending")!; j.status = status; if (result) j.result = result; return j.id; };
  return { db, created, updates, state, finish, raw, createdAt };
}
const cfgOf = (c: Record<string, unknown>) => (c.request as { config: Record<string, unknown> }).config;

// ── H1: the account a job acts on comes from that system's own onboard result ─────────────────────
test("H1: remove jobs target the account each system's onboard REPORTED (fallback name + immutable id), not the payload's username", async () => {
  const { db, created, createdAt } = stubDb();
  const r = await dispatchUserAdhoc(db, "case", "remove", "test");
  assert.equal(r.ok, true);
  assert.deepEqual(created.map((c) => c.systemKey), ["ad-remove-user", "m365-remove-user"]); // google never ran
  const ad = cfgOf(created[0]); const m = cfgOf(created[1]);
  assert.deepEqual(ad.target, { sam: "jmsmyth", upn: "jmsmyth@acme.com", objectGuid: "guid-1", source: "onboard" });
  assert.deepEqual(m.target, { upn: "jmsmyth@acme.com", id: "entra-1", syncEnabled: false, source: "onboard" });
  assert.equal(ad.caseCreatedAt, createdAt.toISOString());
  assert.equal("knownIdentities" in ad, false, "no bag of every name the case ever mentioned");
  // The approver sees exactly which account each step deletes.
  assert.equal(ad.approvalTarget, "Active Directory: jmsmyth (id guid-1)");
  assert.equal(m.approvalTarget, "Microsoft 365: jmsmyth@acme.com (id entra-1)");
  for (const c of created) {
    const req = c.request as { requiresApproval: boolean; captureEvidence: boolean };
    assert.equal(req.requiresApproval, true);
    assert.equal(req.captureEvidence, true);
    assert.equal(c.singleRun, true);
  }
});

test("H1: an onboard that recorded no identity (manual/old job) falls back to the payload — and says so to the approver", async () => {
  const jobs: J[] = [{ id: "a", systemKey: "active-directory", status: "succeeded", request: {}, result: { priorStatus: "failed", manualCompletion: true } }];
  const { db, created } = stubDb({ jobs });
  await dispatchUserAdhoc(db, "case", "remove", "t");
  const cfg = cfgOf(created[0]);
  assert.equal(cfg.target, null);
  assert.match(String(cfg.approvalTarget), /^Active Directory: jsmyth — the onboard recorded no account, so it is deleted only if it was created after this case$/);
});

test("H1: the Remove confirm key and dialog name the accounts the onboard created, not the payload name", () => {
  const jobs = DEFAULT_JOBS();
  const payload = { samAccountName: "jsmyth", userPrincipalName: "jsmyth@acme.com" };
  assert.equal(removeConfirmKey(jobs, payload), "jmsmyth@acme.com");
  assert.deepEqual(removalAccounts(jobs, payload), ["Active Directory: jmsmyth (id guid-1)", "Microsoft 365: jmsmyth@acme.com (id entra-1)"]);
  assert.equal(removeConfirmKey([], payload), "jsmyth@acme.com", "nothing reported — the payload is all there is");
});

test("H1: the approval step in the run report names the account approving it deletes", () => {
  const rr = buildRunReport({
    caseId: "c", caseNumber: null, subject: null, action: "onboard", caseStatus: "completed", client: { name: "A", slug: "a" }, payload: {},
    jobs: [{ systemKey: "ad-remove-user", sequence: 0, mode: "api", status: "pending", request: { requiresApproval: true, config: { approvalTarget: "Active Directory: jmsmyth (id guid-1)" } }, result: null, validation: null, error: null, startedAt: null, finishedAt: null }],
    names: new Map(),
  });
  assert.equal(rr.steps[0].verdict, "needs_approval");
  assert.equal(rr.steps[0].pendingReason, "approving deletes Active Directory: jmsmyth (id guid-1)");
});

// ── H2: only identities a system actually TOOK are carried ─────────────────────────────────────────
test("H2: a SUCCEEDED correction's result becomes that system's target; a FAILED correction contributes nothing", () => {
  const jobs: J[] = [
    ...DEFAULT_JOBS(),
    { id: "c1", systemKey: "ad-correct-user", status: "succeeded", sequence: 10, request: {}, result: { Sam: "jmsmith", Upn: "jmsmith@acme.com", ObjectGuid: "guid-1" } },
    { id: "c2", systemKey: "m365-correct-user", status: "failed", sequence: 11, request: { config: { newUpn: "john.smith@acme.com" } }, result: null },
  ];
  assert.deepEqual(resolveTarget("active-directory", jobs), { sam: "jmsmith", upn: "jmsmith@acme.com", objectGuid: "guid-1", source: "correction" });
  // M365's correction failed (the name was taken by someone else): it still targets what the onboard made.
  assert.deepEqual(resolveTarget("m365", jobs), { upn: "jmsmyth@acme.com", id: "entra-1", syncEnabled: false, source: "onboard" });
});

test("H2: an older runner's correction result without an id keeps the onboard's id", () => {
  const jobs: J[] = [...DEFAULT_JOBS(), { id: "c1", systemKey: "m365-correct-user", status: "succeeded", sequence: 10, request: {}, result: { Actions: ["updated"], Upn: "jmsmith@acme.com" } }];
  assert.equal(resolveTarget("m365", jobs)?.id, "entra-1");
  assert.equal(resolveTarget("m365", jobs)?.upn, "jmsmith@acme.com");
});

test("H2: remove after a correction that failed on M365 targets M365's ONBOARD account, never the failed target name", async () => {
  const { db, created, finish } = stubDb();
  await dispatchUserAdhoc(db, "case", "correct", "t", { email: "john.smith@acme.com" });
  finish("ad-correct-user", "succeeded", { Sam: "john.smith", Upn: "john.smith@acme.com", ObjectGuid: "guid-1" });
  finish("m365-correct-user", "failed");
  finish("exchange-correct-user", "failed");
  await dispatchUserAdhoc(db, "case", "remove", "t");
  const m = cfgOf(created.find((c) => c.systemKey === "m365-remove-user")!);
  assert.equal((m.target as { upn: string }).upn, "jmsmyth@acme.com");
  assert.equal(JSON.stringify(m).includes("john.smith"), false, "the failed correction's name is carried nowhere");
  const ad = cfgOf(created.find((c) => c.systemKey === "ad-remove-user")!);
  assert.equal((ad.target as { sam: string }).sam, "john.smith");
});

// ── correction commit (review 1) ─────────────────────────────────────────────────────────────────
test("correct: jobs carry the previous identity, the target and the pending correction; the payload is untouched at dispatch", async () => {
  const { db, created, updates, state } = stubDb();
  const r = await dispatchUserAdhoc(db, "case", "correct", "t", { lastName: "Smith", email: "jsmith@acme.com" });
  assert.equal(r.ok, true);
  assert.deepEqual(created.map((c) => c.systemKey), ["ad-correct-user", "m365-correct-user", "exchange-correct-user"]);
  const cfg = cfgOf(created[0]);
  assert.equal(cfg.newUpn, "jsmith@acme.com");
  assert.equal(typeof cfg.correctionId, "string");
  assert.deepEqual(cfg.correction, { lastName: "Smith", email: "jsmith@acme.com" });
  assert.equal((cfg.target as { objectGuid: string }).objectGuid, "guid-1");
  assert.equal(typeof cfg.caseCreatedAt, "string");
  assert.equal((cfgOf(created[2]).target as { id: string }).id, "entra-1", "the mailbox is the Entra user the onboard created");
  assert.equal(updates.length, 0);
  assert.equal(state.payload.userPrincipalName, "jsmyth@acme.com");
});

test("the case takes the corrected identity only once EVERY job of that correction succeeded", async () => {
  const { db, updates, state, finish } = stubDb();
  await dispatchUserAdhoc(db, "case", "correct", "t", { lastName: "Smith", email: "jsmith@acme.com" });
  const ad = finish("ad-correct-user", "succeeded");
  assert.equal(await commitUserCorrectionIfComplete(db, ad), false);
  const m = finish("m365-correct-user", "failed");
  assert.equal(await commitUserCorrectionIfComplete(db, m), false);
  const x = finish("exchange-correct-user", "succeeded");
  assert.equal(await commitUserCorrectionIfComplete(db, x), false);
  state.jobs.find((j) => j.id === m)!.status = "succeeded";
  assert.equal(await commitUserCorrectionIfComplete(db, m), true);
  const p = updates[0].payload as Record<string, unknown>;
  assert.equal(p.userPrincipalName, "jsmith@acme.com");
  assert.equal(p.lastName, "Smith");
});

// ── M2: no Correct after a Remove ────────────────────────────────────────────────────────────────
test("M2: Correct is refused once a Remove has succeeded on the case", async () => {
  const jobs: J[] = [...DEFAULT_JOBS(), { id: "r", systemKey: "m365-remove-user", status: "succeeded", sequence: 9, request: {} }];
  const r = await dispatchUserAdhoc(stubDb({ jobs }).db, "case", "correct", "t", { lastName: "Smith" });
  assert.deepEqual(r, { ok: false, status: 409, error: "the user was removed on this case — there's no account left to correct" });
});

// ── M1: the optional mailbox job ─────────────────────────────────────────────────────────────────
test("M1: a cloud client whose mailbox came from the m365 step gets an optional Exchange correction on the M365 credential", async () => {
  const jobs: J[] = [{ id: "m", systemKey: "m365", status: "succeeded", request: { secretNames: ["m365-admin"] }, result: { UserId: "entra-1", Upn: "jsmyth@acme.com", OnPremSyncEnabled: false } }];
  const { db, created } = stubDb({ jobs });
  await dispatchUserAdhoc(db, "case", "correct", "t", { email: "jsmith@acme.com" });
  assert.deepEqual(created.map((c) => c.systemKey), ["m365-correct-user", "exchange-correct-user"]);
  assert.equal(cfgOf(created[1]).mailboxOptional, true);
});

test("M1: no optional Exchange job for a directory-synced user (AD readdresses the mailbox)", async () => {
  const synced: J[] = [{ id: "m", systemKey: "m365", status: "succeeded", request: {}, result: { UserId: "entra-1", Upn: "jsmyth@acme.com", OnPremSyncEnabled: true } }];
  const a = stubDb({ jobs: synced });
  await dispatchUserAdhoc(a.db, "case", "correct", "t", { email: "jsmith@acme.com" });
  assert.equal(a.created.some((c) => c.systemKey === "exchange-correct-user"), false);
  const cloud: J[] = [{ id: "m", systemKey: "m365", status: "succeeded", request: {}, result: { UserId: "entra-1" } }];
  const b = stubDb({ jobs: cloud, client: { backbone: "ad_synced", identity: {} } });
  await dispatchUserAdhoc(b.db, "case", "correct", "t", { email: "jsmith@acme.com" });
  assert.equal(b.created.some((c) => c.systemKey === "exchange-correct-user"), false);
});

test("hybrid: the Exchange correction never brokers the on-prem Exchange session", async () => {
  const jobs = DEFAULT_JOBS();
  jobs[3] = { id: "x", systemKey: "exchange", status: "succeeded", request: { secretNames: ["m365-admin", "exchange-onprem"] } };
  const { db, created } = stubDb({ jobs });
  await dispatchUserAdhoc(db, "case", "correct", "t", { email: "jsmith@acme.com" });
  const x = created.find((c) => c.systemKey === "exchange-correct-user")!;
  assert.deepEqual((x.request as { secretNames: string[] }).secretNames, ["m365-admin"]);
});

// ── ad-standalone: prior #3 + L4 ─────────────────────────────────────────────────────────────────
const STANDALONE_CLIENT = { backbone: "ad_standalone", identity: { adDomain: "syee.local", usernamePatterns: ["{first}{last}"] } };
const STANDALONE_PAYLOAD = { firstName: "John", lastName: "Smyth", samAccountName: "johnsmyth", userPrincipalName: "johnsmyth@acme.com", displayName: "John Smyth" };

test("ad-standalone: AD keeps its own UPN suffix, and its mail/proxyAddresses take the CLOUD email (never the AD UPN)", async () => {
  const { db, created } = stubDb({ client: STANDALONE_CLIENT, payload: STANDALONE_PAYLOAD });
  await dispatchUserAdhoc(db, "case", "correct", "t", { lastName: "Smith", email: "johnsmith@acme.com" });
  const ad = cfgOf(created.find((c) => c.systemKey === "ad-correct-user")!);
  assert.equal(ad.newUpn, "johnsmith@syee.local");
  assert.equal(ad.mailAddress, "johnsmith@acme.com");
  assert.equal((ad.previousIdentity as Record<string, unknown>).UserPrincipalName, "johnsmyth@syee.local");
  assert.equal(cfgOf(created.find((c) => c.systemKey === "m365-correct-user")!).newUpn, "johnsmith@acme.com");
});

test("L4: a committed standalone correction records the AD UPN it set, and adUpnFor prefers it over re-deriving from the names", async () => {
  const { db, finish, updates } = stubDb({ client: STANDALONE_CLIENT, payload: STANDALONE_PAYLOAD });
  await dispatchUserAdhoc(db, "case", "correct", "t", { email: "jsm@acme.com" });
  let last = "";
  for (const k of ["ad-correct-user", "m365-correct-user", "exchange-correct-user"]) last = finish(k, "succeeded");
  assert.equal(await commitUserCorrectionIfComplete(db, last), true);
  const p = updates[0].payload as Record<string, unknown>;
  assert.equal(p.adUpn, "jsm@syee.local");
  // Re-deriving from the names would give johnsmyth@syee.local — the correction's is what AD has now.
  assert.equal(adUpnFor(p, STANDALONE_CLIENT)?.upn, "jsm@syee.local");
});

// ── L1: the in-flight check runs inside the transaction, under a row lock ──────────────────────────
test("L1: the busy check runs inside the transaction after locking the case row", async () => {
  const s = stubDb({ busyInTx: "m365-correct-user" }); // another POST got in between the read and the write
  const r = await dispatchUserAdhoc(s.db, "case", "remove", "t");
  assert.equal(r.ok, false);
  assert.equal((r as { status: number }).status, 409);
  assert.equal(s.created.length, 0);
  assert.equal(s.raw.length, 1);
  assert.match(s.raw[0], /SELECT id FROM "CaseRequest" WHERE id = \? FOR UPDATE/);
});

test("any correct/remove step in flight blocks both kinds", async () => {
  const jobs: J[] = [
    { id: "a", systemKey: "active-directory", status: "succeeded", request: {} },
    { id: "p", systemKey: "ad-correct-user", status: "pending", request: {} },
  ];
  const r = await dispatchUserAdhoc(stubDb({ jobs }).db, "case", "remove", "t");
  assert.equal(r.ok, false);
  assert.equal((r as { status: number }).status, 409);
});

// ── L2: runner version gate + "skipped" is not done ─────────────────────────────────────────────
test("L2: runners older than 1.138.0 (or not reporting a version) are withheld the correct/remove keys", () => {
  assert.deepEqual(userAdhocVersionExclusions("1.126.9").sort(), [...USER_ADHOC_SYSTEM_KEYS].sort());
  assert.deepEqual(userAdhocVersionExclusions(null).sort(), [...USER_ADHOC_SYSTEM_KEYS].sort());
  assert.deepEqual(userAdhocVersionExclusions("1.138.0"), []);
  assert.deepEqual(userAdhocVersionExclusions("2.0.1"), []);
});

test("L2: a 'skipped' correct/remove result is recorded as failed (not done); other keys are untouched", () => {
  const r = userAdhocResultStatus("m365-correct-user", "skipped");
  assert.equal(r.status, "failed");
  assert.match(r.error ?? "", /runner 1.138.0 or later/);
  assert.deepEqual(userAdhocResultStatus("m365", "skipped"), { status: "skipped" });
  assert.deepEqual(userAdhocResultStatus("ad-remove-user", "succeeded"), { status: "succeeded" });
});

// ── L3: re-run rules ─────────────────────────────────────────────────────────────────────────────
test("L3: re-running a correction is refused once a NEWER correction exists", async () => {
  const s = stubDb();
  await dispatchUserAdhoc(s.db, "case", "correct", "t", { email: "a@acme.com" });
  for (const k of ["ad-correct-user", "m365-correct-user", "exchange-correct-user"]) s.finish(k, "failed");
  const oldAd = s.state.jobs.find((j) => j.systemKey === "ad-correct-user")!;
  await dispatchUserAdhoc(s.db, "case", "correct", "t", { email: "b@acme.com" });
  const r = await userAdhocRequeueCheck(s.db, { ...oldAd, caseRequestId: "case" });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /newer correction/);
  const newAd = s.state.jobs.filter((j) => j.systemKey === "ad-correct-user").at(-1)!;
  assert.deepEqual(await userAdhocRequeueCheck(s.db, { ...newAd, caseRequestId: "case" }), { ok: true });
});

test("L3: re-running a remove needs a fresh approval and a fresh 30-day window check", async () => {
  const fresh = stubDb();
  const job = { id: "r", systemKey: "ad-remove-user", caseRequestId: "case", request: { requiresApproval: true, approved: true } };
  const r = await userAdhocRequeueCheck(fresh.db, job);
  assert.equal(r.ok, true);
  assert.deepEqual((r as { patch: unknown }).patch, { approved: false, requiresApproval: true });
  const old = stubDb({ ageDays: 45 });
  const late = await userAdhocRequeueCheck(old.db, job);
  assert.equal(late.ok, false);
});

test("remove is refused past the window and on anything but an onboard", async () => {
  assert.deepEqual(await dispatchUserAdhoc(stubDb({ ageDays: 45 }).db, "case", "remove", "t"), { ok: false, status: 409, error: '"Remove user" is only offered for 30 days after the onboard — offboard this user instead' });
  const off = await dispatchUserAdhoc(stubDb({ action: "offboard" }).db, "case", "remove", "t");
  assert.equal(off.ok, false);
});

test("a correction with no email change doesn't queue Exchange", async () => {
  const { db, created } = stubDb();
  await dispatchUserAdhoc(db, "case", "correct", "t", { firstName: "Jon" });
  assert.equal(created.some((c) => c.systemKey === "exchange-correct-user"), false);
});

test("checkCorrection trims, requires something, and rejects a malformed email", () => {
  assert.deepEqual(checkCorrection({ firstName: " Jon ", email: "" }), { ok: true, value: { firstName: "Jon" } });
  assert.equal(checkCorrection({}).ok, false);
  assert.equal(checkCorrection({ email: "not-an-email" }).ok, false);
});

// ── Round 3 ────────────────────────────────────────────────────────────────────────────────────────
test("N1: Remove is refused when an account existed before the case (rehire / adopted) — and names it", async () => {
  const jobs = DEFAULT_JOBS();
  jobs[1].result = { System: "m365", UserId: "entra-1", Upn: "jmsmyth@acme.com", OnPremSyncEnabled: false, Adopted: true, AccountCreated: "2019-03-01T12:00:00Z" };
  const { db, created } = stubDb({ jobs });
  const r = await dispatchUserAdhoc(db, "case", "remove", "t");
  assert.equal(r.ok, false);
  assert.match(String((r as { error: string }).error), /offboard the user instead: Microsoft 365: jmsmyth@acme\.com \(id entra-1\)/);
  assert.equal(created.length, 0, "nothing queued — not even the AD half");
});

test("N1: an onboard RE-RUN that found this case's own account (Adopted, created after the case) may still be removed", async () => {
  const jobs = DEFAULT_JOBS();
  const { db, created, createdAt } = stubDb({ jobs });
  jobs[1].result = { System: "m365", UserId: "entra-1", Upn: "jmsmyth@acme.com", OnPremSyncEnabled: false, Adopted: true, AccountCreated: new Date(createdAt.getTime() + 60_000).toISOString() };
  const r = await dispatchUserAdhoc(db, "case", "remove", "t");
  assert.equal(r.ok, true);
  assert.equal(cfgOf(created[1]).target && (cfgOf(created[1]).target as { adopted?: boolean }).adopted, false);
});

test("N1: Adopted with no readable creation date counts as pre-existing; a result from before the flag leaves it to the runner", () => {
  assert.equal(preexistingOf(true, null, new Date()), true);
  assert.equal(preexistingOf(false, null, new Date()), false);
  assert.equal(preexistingOf(undefined, "2019-01-01T00:00:00Z", new Date()), null);
  assert.deepEqual(preexistingAccounts(DEFAULT_JOBS(), {}, new Date()), []);
});

test("N2: a Remove that deleted nothing (refused / not found) does not block Correct; one that deleted does", async () => {
  const noop = [...DEFAULT_JOBS(), { id: "r1", systemKey: "ad-remove-user", status: "succeeded", request: {}, result: { Status: "ok", Deleted: false } }];
  assert.equal(removeDeletedSomething(noop), false);
  const { db } = stubDb({ jobs: noop });
  const r = await dispatchUserAdhoc(db, "case", "correct", "t", { firstName: "Jon" });
  assert.equal(r.ok, true);
  const legacy = [...DEFAULT_JOBS(), { id: "r1", systemKey: "ad-remove-user", status: "succeeded", request: {}, result: { Status: "ok" } }];
  assert.equal(removeDeletedSomething(legacy), true, "a result from before the flag counts as deleted");
});

test("N3: an AD correct/remove is refused when every runner of the client is older than 1.138.0", async () => {
  const { db, created } = stubDb({ agents: [{ name: "dc01", semver: "1.126.4" }, { name: "dc02", semver: null }] });
  const r = await dispatchUserAdhoc(db, "case", "remove", "t");
  assert.equal(r.ok, false);
  assert.match(String((r as { error: string }).error), /updated to 1.138.0 or later .* dc01 \(1\.126\.4\), dc02 \(version unknown\)/);
  assert.equal(created.length, 0);
  const ok = stubDb({ agents: [{ name: "dc01", semver: "1.126.4" }, { name: "dc02", semver: "1.138.0" }] });
  assert.equal((await dispatchUserAdhoc(ok.db, "case", "remove", "t")).ok, true);
});

test("N3 (final review): refused when the client has no enabled runner, or none that can run AD", async () => {
  const none = stubDb({ agents: [] });
  const r1 = await dispatchUserAdhoc(none.db, "case", "remove", "t");
  assert.equal(r1.ok, false);
  assert.match(String((r1 as { error: string }).error), /no enabled runner/);
  assert.equal(none.created.length, 0);
  const noAd = stubDb({ agents: [{ name: "fs01", semver: "1.138.0", capabilities: ["directory-sync"] }] });
  const r2 = await dispatchUserAdhoc(noAd.db, "case", "correct", "t", { firstName: "Jon" });
  assert.equal(r2.ok, false);
  assert.match(String((r2 as { error: string }).error), /none of the client's runners can run Active Directory steps \(fs01\)/);
  const ok = stubDb({ agents: [{ name: "fs01", semver: "1.138.0", capabilities: ["directory-sync"] }, { name: "dc01", semver: "1.138.0", capabilities: ["active-directory"] }] });
  assert.equal((await dispatchUserAdhoc(ok.db, "case", "remove", "t")).ok, true);
});
