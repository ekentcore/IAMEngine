// FR #88 — ad-hoc "Correct user" / "Remove user" on an onboard case. Like the password resets these ride
// the Job table without being case work (see adhoc.ts): dispatched on demand, never planned, invisible to
// case status. Each maps a planned directory line to the executor that corrects/removes on that system.
export const REMOVE_USER_KEY: Record<string, string> = {
  "active-directory": "ad-remove-user",
  m365: "m365-remove-user",
  entra: "m365-remove-user", // same module/tenant as m365
  "google-workspace": "google-remove-user",
};

export const CORRECT_USER_KEY: Record<string, string> = {
  "active-directory": "ad-correct-user",
  m365: "m365-correct-user",
  entra: "m365-correct-user",
  exchange: "exchange-correct-user", // the mailbox's primary address is Exchange's to change
  "google-workspace": "google-correct-user",
};

export const USER_ADHOC_SYSTEM_KEYS = [...new Set([...Object.values(REMOVE_USER_KEY), ...Object.values(CORRECT_USER_KEY)])];

// The on-prem ones (routed to the client's own agent, run on the AD module, ad-dc optional).
export const AD_USER_ADHOC_KEYS = ["ad-remove-user", "ad-correct-user"];

// "Remove user" is only offered while the onboard is recent: it exists to undo a hire that fell
// through, not as a general delete button for long-lived accounts.
export const REMOVE_USER_WINDOW_DAYS = 30;

// The identity fields a correction may change, validated before anything is dispatched.
export type UserCorrection = { firstName?: string; lastName?: string; displayName?: string; email?: string };

export function checkCorrection(input: unknown): { ok: true; value: UserCorrection } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "nothing to correct" };
  const o = input as Record<string, unknown>;
  const out: UserCorrection = {};
  for (const k of ["firstName", "lastName", "displayName", "email"] as const) {
    const v = typeof o[k] === "string" ? (o[k] as string).trim() : "";
    if (!v) continue;
    if (v.length > 256) return { ok: false, error: `${k} is too long` };
    out[k] = v;
  }
  if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) return { ok: false, error: "the new email doesn't look like an email address" };
  if (Object.keys(out).length === 0) return { ok: false, error: "enter at least one corrected value" };
  return { ok: true, value: out };
}

// ── Identity bookkeeping for a correction (review fix: the case must not run ahead of the systems) ──
// A correction is only COMMITTED to the case payload once every job it queued has succeeded. Until then
// the case keeps describing the account as it was, and the pending names/email ride on the jobs'
// config — so a failed correction can be re-run (the old identity is still the case's). Which ACCOUNT a
// later Correct/Remove acts on is resolved per system from what that system reported (resolveTarget).

export type AdIdentity = { SamAccountName: string | null; UserPrincipalName: string | null };

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

// The identity fields a correction reads off (and stamps back onto) the case payload.
export function identityOf(payload: Record<string, unknown>) {
  return {
    SamAccountName: str(payload.samAccountName ?? payload.SamAccountName),
    UserPrincipalName: str(payload.userPrincipalName ?? payload.UserPrincipalName),
    DisplayName: str(payload.displayName ?? payload.DisplayName),
    workEmail: str(payload.workEmail),
  };
}

// The case payload once `correction` has landed everywhere. The username follows the email only when it
// was the old email's local part (the same rule the AD step applies). Marked operator-sourced so a
// ServiceNow re-pull keeps it.
// `adUpn`: on an AD-standalone client, the AD UPN the correction set (its own suffix) — recorded so the
// next on-prem lane is handed THAT, not one re-derived from the names (see adUpnFor).
export function correctedPayload(payload: Record<string, unknown>, correction: UserCorrection, opts: { adUpn?: string | null } = {}): Record<string, unknown> {
  const prev = identityOf(payload);
  const next: Record<string, unknown> = { ...payload };
  const touched: string[] = [];
  const set = (k: string, v: unknown) => { next[k] = v; touched.push(k); };
  if (correction.firstName) set("firstName", correction.firstName);
  if (correction.lastName) set("lastName", correction.lastName);
  if (correction.displayName) set("displayName", correction.displayName);
  if (correction.email) {
    set("userPrincipalName", correction.email); set("workEmail", correction.email);
    const local = correction.email.split("@")[0];
    set("mailNickname", local);
    const oldLocal = String(prev.UserPrincipalName ?? "").split("@")[0];
    if (oldLocal && String(prev.SamAccountName ?? "").toLowerCase() === oldLocal.toLowerCase()) set("samAccountName", local.slice(0, 20));
  }
  if (opts.adUpn) set("adUpn", opts.adUpn);
  next.fieldSource = { ...((payload.fieldSource ?? {}) as Record<string, string>), ...Object.fromEntries(touched.map((k) => [k, "operator"])) };
  return next;
}


export const CORRECT_USER_SYSTEM_KEYS = [...new Set(Object.values(CORRECT_USER_KEY))];
export const REMOVE_USER_SYSTEM_KEYS = [...new Set(Object.values(REMOVE_USER_KEY))];

// ── Which ACCOUNT a correct/remove acts on (second review, H1/H2) ─────────────────────────────────────
// Never the payload's username alone: every onboard falls back to an alternate username when the
// primary is taken by someone else (UserPrincipalNameFallbacks), so jsmith@ in the payload may be John's
// while the onboard created jmsmith@ for Jane. Each system's target is read from what THAT system
// reported: the latest SUCCEEDED correction job's result for it (it renamed the account), else its
// onboard job's result. A correction that failed contributes nothing — its target name was never taken.
// With an immutable id (Entra object id, AD objectGUID, Google user id) the runner matches on the id
// alone; without one it falls back to the case's identity, deleting/renaming only an account that was
// provably created for this case (created no earlier than the case).
export type TargetSystem = "active-directory" | "m365" | "google-workspace";
export type SystemTarget = {
  sam?: string | null; upn?: string | null; email?: string | null;
  id?: string | null; objectGuid?: string | null; syncEnabled?: boolean | null;
  // What the onboard said about the account: Adopted = it EXISTED when the onboard ran, AccountCreated
  // = that account's creation date. Raw here; preexistingOf() turns it into "existed before this case".
  adoptedRaw?: boolean | null; accountCreated?: string | null;
  // Set by resolveTarget(…, caseCreatedAt): true = the account existed before this case (a rehire, an
  // operator Adopt) — Remove must refuse it; false = this case created it; null = the onboard didn't say.
  adopted?: boolean | null;
  source: "onboard" | "correction";
};

const ONBOARD_KEYS: Record<TargetSystem, string[]> = {
  "active-directory": ["active-directory"],
  m365: ["m365", "entra"],
  "google-workspace": ["google-workspace"],
};
const CORRECT_KEY_OF: Record<TargetSystem, string> = {
  "active-directory": "ad-correct-user",
  m365: "m365-correct-user",
  "google-workspace": "google-correct-user",
};
export const TARGET_SYSTEM_OF: Record<string, TargetSystem> = {
  "ad-remove-user": "active-directory", "ad-correct-user": "active-directory",
  "m365-remove-user": "m365", "m365-correct-user": "m365",
  "google-remove-user": "google-workspace", "google-correct-user": "google-workspace",
  "exchange-correct-user": "m365", // the mailbox belongs to the Entra user
};

type JobWithResult = { systemKey: string; status: string; sequence?: number | null; result?: unknown };
const envelope = (r: unknown): Record<string, unknown> => {
  // Tolerate a pipeline-leaked array (see jobResultEnvelope): take the last object in it.
  const v = Array.isArray(r) ? [...r].reverse().find((x) => x && typeof x === "object") : r;
  return (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
};
const pickStr = (o: Record<string, unknown>, ...keys: string[]) => { for (const k of keys) { const s = str(o[k]); if (s) return s; } return null; };

function targetFromResult(system: TargetSystem, r: Record<string, unknown>, source: SystemTarget["source"]): SystemTarget | null {
  const t = targetFields(system, r, source);
  // Only carried when the onboard reported them (a result from before the flag has neither).
  if (t && typeof r.Adopted === "boolean") t.adoptedRaw = r.Adopted;
  const accountCreated = t ? pickStr(r, "AccountCreated") : null;
  if (t && accountCreated) t.accountCreated = accountCreated;
  return t;
}
function targetFields(system: TargetSystem, r: Record<string, unknown>, source: SystemTarget["source"]): SystemTarget | null {
  if (system === "active-directory") {
    const t = { sam: pickStr(r, "Sam", "sam"), upn: pickStr(r, "Upn", "upn"), objectGuid: pickStr(r, "ObjectGuid", "objectGuid"), source };
    return t.sam || t.upn || t.objectGuid ? t : null;
  }
  if (system === "m365") {
    const sync = r.OnPremSyncEnabled ?? r.onPremSyncEnabled;
    const t = { upn: pickStr(r, "Upn", "upn"), id: pickStr(r, "UserId", "userId"), syncEnabled: typeof sync === "boolean" ? sync : null, source };
    return t.upn || t.id ? t : null;
  }
  const t = { email: pickStr(r, "Email", "email"), id: pickStr(r, "Id", "id", "GoogleId"), source };
  return t.email || t.id ? t : null;
}

// Round 3 (N1): did the account exist before THIS case? The onboard says Adopted whenever the account
// already existed when it ran — which includes a re-run of this very case finding the account its first
// run created. So Adopted alone isn't "pre-existing": the account's creation date decides. Adopted with
// a creation date no earlier than the case (5 min clock slack) = this case made it; Adopted with an
// earlier or unreadable date = a rehire / operator Adopt. Not Adopted = created fresh. Unknown (an
// onboard result from before the flag) = null, and the runner applies its own creation-date check.
const CREATED_SLACK_MS = 5 * 60_000;
export function preexistingOf(adoptedRaw: boolean | null | undefined, accountCreated: string | null | undefined, caseCreatedAt: Date | string): boolean | null {
  if (adoptedRaw === false) return false;
  if (adoptedRaw !== true) return null;
  const created = accountCreated ? Date.parse(accountCreated) : NaN;
  const since = new Date(caseCreatedAt).getTime();
  if (Number.isNaN(created) || Number.isNaN(since)) return true;
  return created < since - CREATED_SLACK_MS;
}

export function resolveTarget(system: TargetSystem, jobs: JobWithResult[], caseCreatedAt?: Date | string): SystemTarget | null {
  const bySeq = [...jobs].sort((a, b) => (b.sequence ?? 0) - (a.sequence ?? 0));
  const corr = bySeq.find((j) => j.systemKey === CORRECT_KEY_OF[system] && j.status === "succeeded");
  const fromCorr = corr ? targetFromResult(system, envelope(corr.result), "correction") : null;
  const ob = resolveOnboard(system, bySeq);
  const t = fromCorr ?? ob;
  if (!t) return null;
  if (fromCorr && ob) {
    // A correction result names the account's NEW identity; the id rides from the onboard if the
    // correction (an older runner) didn't report one. Whether the account pre-dates the case is the
    // onboard's to say — a rename doesn't change it.
    if (!(fromCorr.id || fromCorr.objectGuid)) { fromCorr.id = ob.id ?? null; fromCorr.objectGuid = ob.objectGuid ?? null; }
    if (ob.adoptedRaw !== undefined) fromCorr.adoptedRaw = ob.adoptedRaw;
    if (ob.accountCreated) fromCorr.accountCreated = ob.accountCreated;
  }
  if (caseCreatedAt !== undefined) {
    const adopted = preexistingOf(t.adoptedRaw, t.accountCreated, caseCreatedAt);
    if (adopted !== null) t.adopted = adopted;
  }
  return t;
}
function resolveOnboard(system: TargetSystem, bySeq: JobWithResult[]): SystemTarget | null {
  // m365 and entra share a tenant: take the first succeeded line that actually reported the account.
  for (const ob of bySeq) {
    if (!ONBOARD_KEYS[system].includes(ob.systemKey) || ob.status !== "succeeded") continue;
    const t = targetFromResult(system, envelope(ob.result), "onboard");
    if (t) return t;
  }
  return null;
}

const SYSTEM_LABEL: Record<TargetSystem, string> = { "active-directory": "Active Directory", m365: "Microsoft 365", "google-workspace": "Google" };

// The account a remove on `system` will delete, in words an approver can check.
export function describeTarget(system: TargetSystem, t: SystemTarget | null, payload: Record<string, unknown>): string {
  const cur = identityOf(payload);
  if (!t) {
    const name = system === "active-directory" ? (cur.SamAccountName ?? cur.UserPrincipalName) : (cur.UserPrincipalName ?? cur.workEmail);
    return `${SYSTEM_LABEL[system]}: ${name ?? "(no username on the case)"} — the onboard recorded no account, so it is deleted only if it was created after this case`;
  }
  const name = system === "active-directory" ? (t.sam ?? t.upn) : system === "m365" ? t.upn : t.email;
  const id = t.objectGuid ?? t.id;
  return `${SYSTEM_LABEL[system]}: ${name ?? "(unnamed)"}${id ? ` (id ${id})` : ""}`;
}

// What an operator types to confirm a Remove: the account the onboard actually created (not the
// payload's name, which may belong to someone else).
export function removeConfirmKey(jobs: JobWithResult[], payload: Record<string, unknown>): string {
  const m = resolveTarget("m365", jobs); const g = resolveTarget("google-workspace", jobs); const a = resolveTarget("active-directory", jobs);
  const cur = identityOf(payload);
  return m?.upn ?? g?.email ?? a?.upn ?? a?.sam ?? cur.UserPrincipalName ?? cur.workEmail ?? "";
}

// The accounts a Remove would delete, one line per directory system the onboard ran.
// Round 3 (N1): the directory systems whose account existed before this case — a Remove must not
// delete a rehire's or an adopted account (it needs an offboard). Empty = Remove may go ahead.
export function preexistingAccounts(jobs: JobWithResult[], payload: Record<string, unknown>, caseCreatedAt: Date | string): string[] {
  const out: string[] = [];
  for (const system of ["active-directory", "m365", "google-workspace"] as TargetSystem[]) {
    const t = resolveTarget(system, jobs, caseCreatedAt);
    if (t?.adopted === true) out.push(describeTarget(system, t, payload));
  }
  return out;
}

// Round 3 (N2): did a Remove actually delete anything? A refused or not-found remove reports Status ok
// with a WARN (recorded succeeded) and Deleted:false — the account is still live, so Correct stays open.
// A result from before the flag counts as deleted (the conservative reading: don't rename after it).
export function removeDeletedSomething(jobs: JobWithResult[]): boolean {
  return jobs.some((j) => REMOVE_USER_SYSTEM_KEYS.includes(j.systemKey) && j.status === "succeeded" && envelope(j.result).Deleted !== false);
}

export function removalAccounts(jobs: JobWithResult[], payload: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const system of ["active-directory", "m365", "google-workspace"] as TargetSystem[]) {
    if (!jobs.some((j) => ONBOARD_KEYS[system].includes(j.systemKey) && j.status === "succeeded")) continue;
    out.push(describeTarget(system, resolveTarget(system, jobs), payload));
  }
  return out;
}

// L2: runners before 1.138.0 have no executor for these keys — they'd post "skipped" and a correction
// would never commit. Withhold the keys from any runner that doesn't report at least that version.
export const USER_ADHOC_MIN_RUNNER = "1.138.0";
function semverAtLeast(v: string, min: string): boolean {
  const p = (s: string) => s.split(".").map((x) => parseInt(x, 10) || 0);
  const a = p(v); const b = p(min);
  for (let i = 0; i < 3; i++) { if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0); }
  return true;
}
export function userAdhocVersionExclusions(semver: string | null | undefined): string[] {
  const v = (semver ?? "").trim();
  return /^\d+\.\d+\.\d+/.test(v) && semverAtLeast(v, USER_ADHOC_MIN_RUNNER) ? [] : [...USER_ADHOC_SYSTEM_KEYS];
}

// L2: a correct/remove job reported "skipped" did NOT happen (no executor on that runner) — record it
// as failed so the case shows it as not done and a correction never counts it as landed.
export function userAdhocResultStatus(systemKey: string, status: string): { status: string; error?: string } {
  if (status === "skipped" && USER_ADHOC_SYSTEM_KEYS.includes(systemKey)) {
    return { status: "failed", error: `the runner has no ${systemKey} executor (it needs runner ${USER_ADHOC_MIN_RUNNER} or later) — nothing was changed; update the runner and re-run this step` };
  }
  return { status };
}
