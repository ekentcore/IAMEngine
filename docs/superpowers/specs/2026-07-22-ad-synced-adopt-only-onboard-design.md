# AD-synced onboard: adopt-only M365/Entra (never create in cloud)

**Feature request:** #0000025 — "Onboardings - AD Synced Clients"
**Date:** 2026-07-22
**Status:** design approved

## Problem

For an `ad-synced` client, the M365/Entra user account is supposed to originate on-prem
in Active Directory and flow into the cloud through Entra Connect (AAD Connect) sync. The
`m365`/`entra` onboard step should only ever *adopt* that synced account — assign
licenses and groups — never create a cloud account.

Today the M365 onboard executor has **no backbone awareness**. Its account-resolution
builds UPN candidates from the person's name (`Coretelligent.M365.psm1` ~692-760); if none
of those candidates resolves to an existing user, it falls straight into the create branch
(`psm1:771` → `New-MgUser`). So when the on-prem AD account carries the *wrong* email/UPN
(the reported "61C" case), the synced cloud user exists but under an unexpected UPN, the
candidates all miss, and the executor creates a **duplicate cloud-only account**.

The request: AD-synced clients must not create cloud accounts unless explicitly set to do
so; on a mismatch/absence the step should locate the mis-synced user or report clearly that
it could not create the account correctly — not silently create a duplicate.

## Policy

For an **onboarding** case where `client.backbone === 'ad_synced'`, the `m365` and `entra`
lanes are **adopt-only**: the step must resolve an existing (synced) account and must never
run `New-MgUser`, unless cloud-create is explicitly enabled via an override.

For every other backbone (`entra`, roster-only, etc.) behavior is unchanged — creation is
allowed exactly as today. `ad_standalone` is out of scope (no cloud-sync path).

### Overrides (a client can be "specifically set to" allow creation)

Either of the following flips the policy for an ad-synced client back to allow:

1. **Persistent client/system flag** — `onboard.allowCloudCreate: true` on the client's
   `m365` and/or `entra` system config. Default absent = false. Edited via the existing
   Edit-systems config.
2. **Per-case override** — an "Allow M365/Entra cloud account creation" toggle on the
   onboard run, injected into the plan config at plan time. Non-persistent; for the
   one-off case where an operator knows this user legitimately needs a cloud account.

## Design (Approach A — plan-time policy + runner enforcement)

Policy is decided in the web planner (unit-testable, matches the existing rehire
`usernameCollisionPolicy:"adopt"` injection at `plan-resolve.ts:304`); the runner enforces
it. This mirrors patterns already in the codebase and keeps PowerShell dumb.

### Web — `web/lib/profiles/plan-resolve.ts`

At plan time for onboard cases, compute a `cloudCreate` policy and stamp it onto the
resolved `m365`/`entra` onboard config (the `ADOPTING_SYSTEMS` set already enumerates
exactly these two lanes):

```
cloudCreate = (backbone === 'ad_synced'
               && !systemConfig.onboard?.allowCloudCreate
               && !caseOverride)
              ? 'deny'
              : 'allow'
```

- `backbone` is available at plan time from the `Client` row.
- `caseOverride` comes from the onboard run form (see UI below), threaded into
  `plan-resolve` alongside the other case-time options.
- Only `m365` and `entra` configs are stamped. Offboard/other lanes untouched.

The stamped field rides in `Job.request.config` and is returned verbatim to the runner in
`runner-service.ts` (same channel as `usernameCollisionPolicy`).

### Web UI — per-case override

Add an "Allow M365/Entra cloud account creation" checkbox to the onboard run/plan form,
shown only when the target client's backbone is `ad_synced` (otherwise the policy is
already `allow` and the toggle is meaningless). Its value threads into `plan-resolve` as
`caseOverride`. Default unchecked.

The persistent `onboard.allowCloudCreate` flag needs no bespoke control — it is set through
the existing Edit-systems config editing for the `m365`/`entra` systems.

### Runner — `runner/modules/Coretelligent.M365/Coretelligent.M365.psm1`

`entra` dispatch already aliases `m365` (`Start-IamRunner.ps1:1529`), so a single change to
`Invoke-CtgM365Onboarding` covers both lanes.

1. **Broader synced-user search** — new helper `Find-CtgM365SyncedUser`. After the current
   UPN candidates all miss (~726-760), search Graph for a synced match, in order:
   - `onPremisesImmutableId` (if we can derive/have it),
   - `mail` / proxyAddresses,
   - `displayName` filtered to `onPremisesSyncEnabled eq true`.
   Returns the best likely match (with its actual UPN) or `$null`.

2. **Gate the create branch** at `psm1:771` on `config.cloudCreate`:
   - `deny` **and** broader search finds a likely synced user →
     throw `DECISION_NEEDED:synced_upn_mismatch` carrying actual vs expected UPN, e.g.
     *"found `jdoe@x.com`, expected `john.doe@x.com` — the on-prem UPN/email looks wrong;
     verify the AD email address and re-sync. Did NOT create in cloud."* No create.
   - `deny` **and** nothing found →
     fail clearly: *"no synced M365 account for <name> at <upn>; AD sync is pending or the
     on-prem UPN/email is wrong; did NOT create in cloud."* No create.
   - `allow` (or field absent, for back-compat with non-ad-synced) →
     current `New-MgUser` behavior, unchanged.

3. The existing collision/adopt branch (same-name account found by a candidate) is
   untouched — this change only governs the *"no candidate resolved → create"* path.

### Surfacing

Reuse the existing `DECISION_NEEDED` convention (as `username_collision` does) so the
mismatch lands as a decision item on the case. The clean-fail path writes the usual
`AuditLog` row + ServiceNow work note (existing executor behavior).

## Testing

**Web (`plan-resolve` unit tests):**
- ad_synced client → `m365`/`entra` config stamped `cloudCreate: 'deny'`.
- ad_synced + `onboard.allowCloudCreate: true` on the system → `'allow'`.
- ad_synced + per-case override → `'allow'`.
- `entra` backbone → `'allow'` (or unstamped-but-allowed); no `deny` ever stamped.
- Offboard cases: field not stamped.

**Runner (Pester, `Coretelligent.M365`):**
- `deny` + no user found anywhere → throws clean failure, `New-MgUser` never called.
- `deny` + user found only via display name (UPN mismatch) → throws
  `DECISION_NEEDED:synced_upn_mismatch` with both UPNs; `New-MgUser` never called.
- `allow` + no user → creates as today.
- `entra`-backbone-equivalent (`cloudCreate: 'allow'`) unaffected.

Run Pester via `~/.local/pwsh/pwsh` (not on PATH).

## Rollout

- Bump `runner/VERSION` (minor — backward compatible; default for non-ad-synced clients is
  unchanged, and absent `cloudCreate` = allow). **Runner needs deploy.**
- No migration (uses existing `Backbone` enum + `Job.request.config`).

## Out of scope

- `ad_standalone` backbone (no cloud-sync origin).
- Making the `directory-sync` executor wait for / verify the synced object (addresses the
  race, not the wrong-UPN case that this FR is actually about).
- Auto-correcting the on-prem AD email/UPN — the operator fixes AD and re-syncs; we only
  detect and report.
