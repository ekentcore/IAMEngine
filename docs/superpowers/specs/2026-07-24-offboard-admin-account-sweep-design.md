# Offboard "-a" admin-account sweep — design

Date: 2026-07-24
Requested: "On Coretelligent offboardings, add a check for whether the person has a `-a`
account (mgallegos@core.tech → mgallegos-a@core.tech) and disable it in AD, Exchange,
M365, Entra etc. the same way the regular account is disabled."

## Problem

Coretelligent engineers hold a privileged secondary account named `<sam>-a`. Offboarding
today disables only the primary account; the `-a` account stays live — an enabled,
privileged credential for someone who has left.

## Key constraint

An offboard case carries `userToOffboard` as a **display name** ("Miguel Gallegos"); the
UPN/sam are only known once an executor resolves the primary against the directory. So the
`-a` identity (`mgallegos-a`) can only be derived **at execution time** from the resolved
primary — this cannot be planned as separate jobs with concrete targets, and a standalone
"-a check" step would have to duplicate every system's connection + secret machinery.

## Approaches considered

1. **Per-executor sweep driven by lane config (chosen).** A new offboard-lane config key
   `adminAccountSuffix: "-a"`. Each of the three identity executors (AD, Exchange,
   M365/Entra), after finishing the primary offboard, derives the admin identity from the
   resolved primary, checks for it **exactly** (no fuzzy matching), and when it exists
   re-invokes itself against it (depth-1 recursion, suffix stripped from the passed
   config). Full reuse of the existing idempotent disable path; result lines land in the
   same step's Actions log.
2. Separate planned "-a" jobs per system — rejected: no concrete target at plan time,
   doubles job count, needs a discovery step + re-plan loop.
3. One new `admin-account-check` systemKey — rejected: one step cannot disable across
   AD + EXO + Graph without duplicating connections/secrets, and crosses the
   one-system-per-step architecture.

## Design

### Config

- `adminAccountSuffix` (string, e.g. `"-a"`; validated `^[A-Za-z0-9._-]{1,16}$`) on the
  offboard lane config of `active-directory`, `exchange`, and `entra` (NOT `m365` — both
  lanes share one executor; stamping only `entra` runs the sweep once and keeps it out of
  the license lane).
- Set for Coretelligent in `profiles/coretelligent.json` and
  `web/scripts/wire-coretelligent-offboard.ts` (the prod wiring script). Documented in
  `profiles/_schema.json`. Any client can adopt it later — nothing is hardcoded to
  Coretelligent.
- No web code change needed: lane config already flows planner → Job.request → runner
  untouched. Existing open cases need a re-plan to pick it up (config is snapshotted at
  plan time).

### Runner (1.99.1 → 1.100.0)

In each executor, immediately before the final result construction (both functions have a
single success return; DECISION_NEEDED paths are action lines, not early returns):

1. Read `adminAccountSuffix` off `$Config`; skip (with WARN) if it isn't a valid
   sam/UPN fragment.
2. Derive: AD `adminSam = <resolved sam> + suffix` (+ UPN variant when the primary has a
   UPN); Exchange/M365 `adminUpn = <local part> + suffix + @domain` from the resolved UPN.
3. Exact existence check (AD `-Filter "SamAccountName -eq …"`, then UPN; M365
   `Get-MgUser -Filter "userPrincipalName eq …"`; Exchange `Get-Recipient -Identity`).
   - Absent → action `admin account check: no <admin id> — nothing extra to disable`.
     A missing `-a` account can never pause a case: we never enter the
     candidates/ambiguity machinery for the derived identity.
   - Present → action `admin account check: found <admin id> — disabling it the same way`,
     then recurse with a config clone **minus**:
     - all modules: `adminAccountSuffix` (recursion depth 1);
     - AD: `disableComputer`/`computerName`/`disabledComputersOu` (the -a account has no
       workstation of its own);
     - M365: `removeLicense`, `mailbox`, `oneDriveBackup`, `oneDriveGrantAccessTo`
       (license/mailbox decision machinery must never park a case over an admin account;
       an unlicensed -a account has nothing there anyway);
     - Exchange: `convertToShared`, `mailbox`, `delegateManagerFullAccess`,
       `grantFullAccessTo`, `autoReply`, `forwarding` (mail-continuity rituals are for the
       departing person's mailbox, not a privileged secondary; `hideFromGal` and
       `blockMobileDevices` are kept).
4. Merge: recursion's Actions appended prefixed `[<admin id>] …`; recursion's Evidence
   attached as `Evidence.AdminAccount`; primary result fields (Sam/UserId/Upn/Manager/
   MailboxSizeGB) stay authoritative — downstream consumers are untouched.
5. Errors in the sweep propagate (fail loudly) — the job goes red rather than reporting a
   green offboard over a still-enabled admin account; re-runs are idempotent.

What the -a account gets, concretely: AD password reset + group strip + hide from GAL +
manager clear + disable + OU move; Entra block sign-in + revoke sessions + MFA method
removal + cloud group removal + device disable; Exchange hide from GAL + ActiveSync/OWA
block + cloud DL removal (each a graceful no-op when the -a account has no mailbox).

### Testing

Pester (run via `~/.local/pwsh/pwsh`): per module — sweep disables the -a account when it
exists; reports the clean "no -a account" line when it doesn't; no behavior change when
the suffix isn't configured; excluded keys don't reach the recursion.

### Out of scope / follow-ups

- `Confirm-Ctg*` validators still verify only the primary account (the sweep fails loudly
  on its own, so a green step still implies the -a work completed). Extending read-back to
  the -a account is a follow-up.
- Other systems (Zoom, Duo, …): -a accounts don't exist there; the suffix key is simply
  not set on those lanes.
- Prod rollout: deploy runner 1.100.0, run `wire-coretelligent-offboard.ts --apply`,
  re-plan any open Coretelligent offboard cases.
