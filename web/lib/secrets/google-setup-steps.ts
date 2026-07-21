// Which of the 5-step "set up Google Workspace automatically" tracker steps a backend stage belongs
// to, plus which step a `needs_action` run should flag as still needing a human. Pure + exported so
// the mapping is unit-testable without mounting the React component — component tests aren't part of
// this repo's test glob (see package.json's `test` script: `tsx --test "lib/**/*.test.ts"`, nothing
// under app/), so this pure routing logic lives here instead of inline in google-setup-button.tsx.
//
// The 5 steps (their labels live in google-setup-button.tsx; this file only owns the STAGE -> STEP
// INDEX routing):
//   0 Sign in to Google                 <- eligibility, oauth-dispatch, oauth-code
//   1 Create the service account        <- provision
//   2 Grant domain-wide delegation      <- dwd-dispatch, dwd-grant
//   3 Save the credential to Delinea    <- verify, write
//   4 Test the connection               <- done (the connection test itself is a separate, auto
//                                          triggered thing — see ensureGoogleConnTestTriggered — but
//                                          the tracker's last step lights up once the run reaches "done")
const STEP_STAGES: readonly (readonly string[])[] = [
  ["eligibility", "oauth-dispatch", "oauth-code"],
  ["provision"],
  ["dwd-dispatch", "dwd-grant"],
  ["verify", "write"],
  ["done"],
];

// -1 for a stage that isn't in any step: "error" (failures are shown via the failed/step-status path,
// not this mapping), an unknown/unrecognized stage, or no stage at all yet.
export function stepOf(stage?: string | null): number {
  if (!stage) return -1;
  return STEP_STAGES.findIndex((stages) => stages.includes(stage));
}

// A `needs_action` run always finished the core chain (its reported stage IS "done" — the credential
// was written), but the DWD grant was never confirmed automatically, so the step that actually needs a
// human is step 2 ("Grant domain-wide delegation"), overriding the plain stage-based mapping above.
export const NEEDS_ACTION_STEP = 2;

// The step to flag as "needs a human", given the run's overall status. Only `needs_action` has one —
// every other status (pending/running/done/failed/skipped) defers entirely to stepOf(stage).
export function needsActionStep(status?: string | null): number | null {
  return status === "needs_action" ? NEEDS_ACTION_STEP : null;
}
