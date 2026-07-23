// Go-live rollup: two pure reducers over the CheckResult[] the registry produced — one per-client
// (worst verdict across that client's per-client checks) and one global (the overall GO / NO-GO gate).
// Verdict ordering fail > warn > pass; `na` is ignored (a check that doesn't apply neither helps nor
// hurts). Both are pure so they unit-test without a DB, matching the repo's existing test style.
import type { CheckResult, Verdict } from "./checks";

export type OverallVerdict = "GO" | "GO_WITH_WARNINGS" | "NO_GO";

export type ClientRollup = {
  slug: string;
  name: string;
  verdict: Verdict; // worst across this client's per-client checks (na if none applied)
  checks: CheckResult[];
};

const RANK: Record<Verdict, number> = { pass: 1, warn: 2, fail: 3, na: 0 };

// Worst verdict across a set of checks. `na` counts as nothing; a set that is ALL na rolls up to na.
export function worstVerdict(checks: CheckResult[]): Verdict {
  let worst: Verdict = "na";
  for (const c of checks) {
    if (RANK[c.verdict] > RANK[worst]) worst = c.verdict;
  }
  return worst;
}

// Roll one client's per-client checks up to a single verdict + carry the checks for the expandable row.
export function rollupClient(slug: string, name: string, checks: CheckResult[]): ClientRollup {
  return { slug, name, verdict: worstVerdict(checks), checks };
}

export type OverallRollup = {
  verdict: OverallVerdict;
  blockingFailures: number; // blocking checks (global or per-client) that failed — the hard gate
  warnings: number; // warn verdicts across every check
  nonBlockingFailures: number; // failed checks that don't block (degrade to GO_WITH_WARNINGS)
  clientsNotReady: number; // clients whose rollup verdict is fail
};

// The overall gate:
//   NO_GO             if any BLOCKING check (global or per-client) failed
//   GO_WITH_WARNINGS  if no blocking fail but there's any warn or any non-blocking fail
//   GO                if everything is pass / na
export function overallVerdict(globalChecks: CheckResult[], clients: ClientRollup[]): OverallRollup {
  const perClient = clients.flatMap((c) => c.checks);
  const all = [...globalChecks, ...perClient];

  let blockingFailures = 0;
  let nonBlockingFailures = 0;
  let warnings = 0;
  for (const c of all) {
    if (c.verdict === "fail") (c.blocking ? blockingFailures++ : nonBlockingFailures++);
    else if (c.verdict === "warn") warnings++;
  }
  const clientsNotReady = clients.filter((c) => c.verdict === "fail").length;

  const verdict: OverallVerdict = blockingFailures > 0 ? "NO_GO" : warnings > 0 || nonBlockingFailures > 0 ? "GO_WITH_WARNINGS" : "GO";
  return { verdict, blockingFailures, warnings, nonBlockingFailures, clientsNotReady };
}
