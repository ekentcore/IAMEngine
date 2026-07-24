// Ad-hoc "Generate random password" jobs (INC0855142): dispatched on demand from a case's
// AD / M365 / Google Workspace line, not part of any plan. The app generates the password
// (revealed once to the operator, then wiped), stores it on Job.oneTimePassword, and injects it
// into the runner config at claim time; the runner never returns it in a result. These jobs are
// singleRun (claimable on a completed/paused case, no cascade) and are invisible to the case
// status/dependency machinery (see runner-logic.ts) so a failed reset can't fail the case.
export const PASSWORD_RESET_KEY: Record<string, string> = {
  "active-directory": "ad-password-reset",
  m365: "m365-password-reset",
  entra: "m365-password-reset", // same module/tenant as m365
  "google-workspace": "google-password-reset",
};

export const PASSWORD_RESET_SYSTEM_KEYS = [...new Set(Object.values(PASSWORD_RESET_KEY))];

// FR#31: pick which of a case's planned jobs a pre-run "reset password" action should dispatch
// against, before any step has actually executed (an imported case pauses on import — the operator
// may need to reset a password before the engine runs anything). Preference order matches the
// on-prem-first bias the rest of the app uses for AD-backbone clients: AD wins if present, then the
// cloud identity lanes. Returns null when the case has no password-resettable system planned at all.
const RESET_SOURCE_ORDER = ["active-directory", "m365", "entra", "google-workspace"];
export function pickResetSourceJob(jobs: { id: string; systemKey: string; status: string }[]): string | null {
  for (const key of RESET_SOURCE_ORDER) {
    const j = jobs.find((j) => j.systemKey === key);
    if (j) return j.id;
  }
  return null;
}
