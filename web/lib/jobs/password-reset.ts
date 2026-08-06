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
// may need to reset a password before the engine runs anything). Returns null when the case has no
// password-resettable system planned at all.
//
// Two rules, in this order:
//
// 1. AD FIRST, always. A client running an AD lane is on-prem-mastered: every directory above it holds
//    a synced copy, so a reset written to the copy is refused outright or silently overwritten by the
//    next sync cycle. This is the on-prem-first bias the rest of the app uses, and the backbone never
//    overrides it.
// 2. Among the CLOUD lanes, the client's backbone decides. This is FR #0000080: the order was one
//    hardcoded list with google-workspace LAST, applied to every client regardless of backbone. A
//    Google-backbone client commonly also has an M365 lane (Google for mail, M365 for the Office
//    apps), so the reset landed in M365 — the operator changed a password in a tenant the user does
//    not sign in to, and the real one was never touched.
const AD_FIRST = "active-directory";
const CLOUD_ORDER_DEFAULT = ["m365", "entra", "google-workspace"];
const CLOUD_ORDER_GOOGLE = ["google-workspace", "m365", "entra"];

export function pickResetSourceJob(
  jobs: { id: string; systemKey: string; status: string }[],
  // The client's backbone (Client.backbone). Optional so an unknown/roster-only client — and any
  // caller that hasn't got it to hand — keeps exactly the previous behaviour.
  backbone?: string | null,
): string | null {
  const order = [AD_FIRST, ...(backbone === "google" ? CLOUD_ORDER_GOOGLE : CLOUD_ORDER_DEFAULT)];
  for (const key of order) {
    const j = jobs.find((j) => j.systemKey === key);
    if (j) return j.id;
  }
  return null;
}
