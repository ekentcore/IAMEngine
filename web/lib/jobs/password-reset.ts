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
