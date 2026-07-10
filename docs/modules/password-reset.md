# Ad-hoc password reset (`ad-password-reset` · `m365-password-reset` · `google-password-reset`)

`Modules: Coretelligent.ActiveDirectory / .M365 / .GoogleWorkspace (ride the existing modules)` ·
`Mode: api` · `Lanes: none (operator-dispatched, never planned)` · `Origin: INC0855142`

"Generate random password" on a case's Active Directory / M365 / Entra / Google Workspace
line: one click sets a completely random new password on that account and shows it to the
operator **exactly once** (popup with copy). It exists because the initial-password reveal
only covers generate-mode m365/entra onboards — an AD or Google onboard (or any account
after the fact) had no way to hand the operator a working password.

### Flow (app is the source of truth for the value)

1. Operator clicks the line's button in the run report → confirm dialog →
   `POST /api/jobs/:jobId/reset-password` (`guard("case.dispatch")` + `jobInScope`).
2. The app generates the value (`generateInitialPassword()`, crypto RNG, AD/M365-compliant),
   creates a `singleRun` Job of the mapped reset systemKey (sequence = max+1, request cloned
   from the source line so secrets/config resolve identically), and stores the plaintext on
   `Job.oneTimePassword`.
3. Claim injects it as `config.newPassword` (kept across lease re-claims; never persisted
   into `request`). The executor resolves the user the same way the line's own executor
   does, sets the password with **force change at next sign-in**, and returns actions only —
   never the value. M365 refuses AD-synced users with a pointer to the AD line.
4. The popup polls `POST /api/jobs/:id/reveal-reset-password`; on success it returns the
   password once and wipes the column (410 after). A failed/skipped result wipes it too.
   If the popup was closed early, the reset line offers "reveal password (once)".

### Isolation guarantees

- The reset keys are filtered out of `deriveCaseStatus` and the dependency gate
  (`runner-logic.ts`): a failed reset can't fail the case, a pending one can't hold it open
  or block real steps, and the auto-verify sweep skips them.
- `ad-password-reset` is in `ALWAYS_ON_PREM_SYSTEMS` and rides the `active-directory`
  capability, so only an RSAT-capable client agent claims it; the cloud keys run centrally.
- The plaintext never lands in `Job.result`, RunOutcome, audit rows, or work notes, and the
  runner scrubs `config.newPassword` out of any posted error text (`Protect-CtgSecretsInText
  -ExtraValues`).

### Requires

Runner ≥ 1.35.0 (dispatch entries + `Invoke-Ctg{AD,M365,Google}PasswordReset`) and the
`Job.oneTimePassword` migration. Buttons appear on verified/warning lines only (the account
must exist).
