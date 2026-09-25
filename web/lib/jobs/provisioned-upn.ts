// The account the m365/entra step ACTUALLY created for a new hire (FR #118, PR #111 reviews 1-4).
//
// The payload's userPrincipalName is only the PRIMARY candidate. When it already belongs to someone
// else, the m365 executor moves on to the next fallback pattern and creates the hire there — and says
// so in its result (`Upn`). A downstream step that acts on the new hire by reading the payload would act
// on the primary, i.e. on the OTHER person: the sharepoint mirror would have added a stranger to the
// reference user's SharePoint site groups. So the app hands the created account on at claim time, as
// payload.provisionedUpn — the same sibling-result hand-off as writebackEmail — together with the
// rule the runner must apply when there is no reported account (sharepointAccountDecision below).
import { jobResultEnvelope } from "./job-result";

type When = Date | string | null | undefined;

export type SiblingResult = {
  systemKey: string;
  status: string;
  result: unknown;
  // As PLANNED (orchestrator: api, or manual/scim — manual also when its secrets are marked not needed).
  mode?: string;
  startedAt?: When;
  progressAt?: When;
  // The most recent FAILED run outcome of this system on the case (RunOutcome, validate-only excluded).
  // It is an accepted failure only if an operator resolved it AND it belongs to the latest run.
  latestFailure?: { at: When; resolvedAt: When } | null;
};

const ms = (w: When): number | null => {
  if (w === null || w === undefined) return null;
  const t = w instanceof Date ? w.getTime() : Date.parse(w);
  return Number.isNaN(t) ? null : t;
};
const isCloud = (s: SiblingResult) => s.systemKey === "m365" || s.systemKey === "entra";
const byM365First = (a: SiblingResult, b: SiblingResult) => (a.systemKey === "m365" ? 0 : 1) - (b.systemKey === "m365" ? 0 : 1);

// The created account's UPN from the case's m365/entra jobs: a SUCCEEDED one whose result carries a
// UPN (PascalCase `Upn`, as the runner emits; lowercase tolerated). m365 wins over entra. null when no
// such result exists.
export function provisionedUpnFrom(siblings: SiblingResult[]): string | null {
  for (const s of [...siblings].sort(byM365First)) {
    if (s.status !== "succeeded" || !isCloud(s)) continue;
    const res = (jobResultEnvelope(s.result) ?? {}) as { Upn?: unknown; upn?: unknown };
    const upn = res.Upn ?? res.upn;
    if (typeof upn === "string" && upn.includes("@")) return upn.trim();
  }
  return null;
}

// When the job last RAN on a runner: its latest start, or the last progress of that run, whichever is
// later. Not finishedAt — "mark complete" overwrites that with the moment of the manual flip.
function lastRanAt(s: SiblingResult): number | null {
  const a = ms(s.startedAt), b = ms(s.progressAt);
  return a === null ? b : b === null ? a : Math.max(a, b);
}

// An operator's acceptance counts only for the LATEST run: the resolved failure must be the newest
// failed outcome and must not predate the job's latest start. An acceptance kept over from an earlier
// run, while a re-run now waits on a decision, is not an acceptance of that re-run.
function acceptedLatest(s: SiblingResult): boolean {
  const f = s.latestFailure;
  if (!f || ms(f.resolvedAt) === null) return false;
  const at = ms(f.at), started = ms(s.startedAt);
  return started === null || (at !== null && at >= started);
}

export type AccountRule = "reported" | "wait" | "operator-required" | "planned-manual" | "no-cloud-step";

export type SharepointAccountFields = {
  provisionedUpn: string | null;
  accountRule: AccountRule;
  // The Username an operator set on the case, when it satisfies the rule (fresh for operator-required).
  confirmedUpn: string | null;
  // Why an operator-set Username is required — named in the runner's refusal.
  accountReason: string | null;
};

type CasePayload = { userPrincipalName?: unknown; fieldSource?: unknown; fieldEditedAt?: unknown };

// What the sharepoint ONBOARD job is told about the new hire's account. Rules, in order:
//   reported          a succeeded api step reported the account (provisionedUpn).
//   wait              an api m365/entra step can still report it: not succeeded/skipped, and not a
//                     failure accepted for its latest run (a DECISION_NEEDED collision is exactly this).
//   operator-required an api step exists that did NOT report it (accepted failure, done by hand,
//                     skipped, succeeded without a Upn). It may have failed BECAUSE the primary is
//                     someone else's, so the primary is never used: only a Username an operator set on
//                     the case AFTER that step last ran.
//   planned-manual    the cloud step is manual/scim BY PLAN. An operator-set Username (any time) wins,
//                     else the runner may use the sole candidate.
//   no-cloud-step     no m365/entra step at all: the runner may use the sole candidate.
export function sharepointAccountDecision(siblings: SiblingResult[], payload: CasePayload): SharepointAccountFields {
  const cloud = siblings.filter(isCloud);
  const upn = typeof payload.userPrincipalName === "string" ? payload.userPrincipalName.trim() : "";
  const source = ((payload.fieldSource ?? {}) as Record<string, unknown>).userPrincipalName;
  const operatorUpn = upn && source === "operator" ? upn : null;
  const editedAt = ms(((payload.fieldEditedAt ?? {}) as Record<string, When>).userPrincipalName);
  const out = (accountRule: AccountRule, confirmedUpn: string | null = null, accountReason: string | null = null): SharepointAccountFields =>
    ({ provisionedUpn: null, accountRule, confirmedUpn, accountReason });

  const provisionedUpn = provisionedUpnFrom(cloud);
  if (provisionedUpn) return { ...out("reported"), provisionedUpn };
  if (cloud.length === 0) return out("no-cloud-step");

  const automated = cloud.filter((s) => (s.mode ?? "api") !== "manual" && s.mode !== "scim");
  const finished = (s: SiblingResult) => ["succeeded", "skipped", "manual"].includes(s.status) || (s.status === "failed" && acceptedLatest(s));
  if (automated.some((s) => !finished(s))) {
    return out("wait");
  }
  if (automated.length > 0) {
    const s = [...automated].sort(byM365First)[0];
    const how = s.status === "failed" ? "its failure was accepted" : s.status === "skipped" ? "it was skipped" : s.status === "manual" ? "it was left to be done by hand" :
      (jobResultEnvelope(s.result) as { manualCompletion?: unknown } | null)?.manualCompletion ? "it was marked complete by hand" : "it finished without reporting one";
    const ran = Math.max(...automated.map((a) => lastRanAt(a) ?? -Infinity));
    const fresh = operatorUpn !== null && (ran === -Infinity || (editedAt !== null && editedAt > ran));
    const reason = `the ${s.systemKey} step didn't report the account it created (${how})`;
    return out("operator-required", fresh ? operatorUpn : null, reason);
  }
  return out("planned-manual", operatorUpn);
}
