# Make `ad-dc` an optional secret for Active Directory

**Status:** design approved (2026-07-15)
**Author:** Claude (with ekent@core.tech)

## Problem

Marking Brock Built's `ad-dc` credential "not needed" broke Active Directory on case
UM0029763. `ad-dc` sits in every AD job's **required** `secretNames`, so the app brokers it
from Delinea *before* dispatch. Brock Built's `ad-dc` externalId is now empty/invalid, so
brokering fails (`delinea_denied` / HTTP 502 / `reference_missing`) and the job dies **before
the runner runs** — which means PR #69's ambient-SYSTEM AD auth never even gets a chance.

Since PR #69, the runner authenticates to AD as its own SYSTEM identity on a writable domain
controller and needs no `ad-dc` credential there. So `ad-dc` should not be a hard requirement
for AD to run.

## Goal

Make `ad-dc` **optional** for the AD-family systems, fleet-wide — mirroring how `spanning-portal`
is optional for `spanning`. Then:
- An absent / not-needed / broken `ad-dc` is a non-event (like an unwired `spanning-portal`),
  not a broker failure.
- AD jobs dispatch and authenticate as ambient SYSTEM on a DC (PR #69).
- When `ad-dc` **is** wired and valid, it's attached and used as the fallback (member-server case).

## Non-goals

- No new per-secret `required` DB column / UI toggle. The existing `OPTIONAL_SECRETS` registry
  already expresses "required by default, these are optional" and is the chosen mechanism.
- No broader "empty externalId shouldn't resolve to secret 0" hardening (see Follow-ups).
- No change to PR #69's runner auth ladder.

## Decisions (approved)

1. **Reuse `OPTIONAL_SECRETS`** rather than a new `required` field.
2. **Fleet-wide**: `ad-dc` is optional for every AD client. A member-server agent that doesn't
   wire `ad-dc` will now fail at **runtime** with PR #69's clear "not a DC — needs a credential"
   error, instead of being blocked at plan time as a manual step. Accepted.

## Design

### The AD-family systems
`active-directory`, `directory-sync`, `ad-email-writeback`, `ad-consistency-check`,
`ad-hard-match`, `ad-password-reset` (`ALWAYS_ON_PREM_SYSTEMS`, `web/lib/cases/case-secrets.ts:29`).

### Web

1. **Register `ad-dc` optional** — `web/lib/secrets/optional-secrets.ts`: add each AD-family key
   `→ ["ad-dc"]` to `OPTIONAL_SECRETS` (alongside `spanning → ["spanning-portal"]`).

2. **Filter optional names out of required `secretNames` at plan time** — so we do **not** have
   to migrate every existing `ClientSystem.secretNames: ["ad-dc"]` row. Where jobs are built from
   a system's `secretNames` (`web/lib/orchestrator.ts` / `web/lib/jobs/runner-service.ts:106`
   already computes `optionalSecretNames` via `wiredOptionalSecrets`), strip any
   `ALL_OPTIONAL_SECRET_NAMES` entry from the required list. Result per planned job:
   - required `secretNames` no longer contains `ad-dc` → never brokered up-front → runner
     dispatches and uses ambient SYSTEM;
   - `optionalSecretNames` carries `ad-dc` **only when the client wired it** (`secretIsSet`),
     so a valid `ad-dc` is still available to the runner as the fallback.

3. **Wiring panel + readiness treat `ad-dc` as optional** — a registry-optional secret is optional
   everywhere, even when a `ClientSystem` still lists it: `web/lib/secrets/wiring.ts` (`deriveSecretRows`
   marks any `isOptionalSecret` name `optional: true`) and `web/lib/clients/readiness.ts`
   (`computeClientReadiness` filters optional names out of `missingSecrets` and the not-needed rule).
   Otherwise a DC client would show a false "ad-dc credential not set" / "AD not ready".

   **Catalog hygiene deliberately skipped:** we do NOT strip `ad-dc` from `system-map.ts` / `seed.ts` /
   the synthetic jobs. Leaving it in `secretNames` is harmless (the plan-time transform strips it from
   *required* and re-attaches it only when wired), and it keeps the transform's "attach the wired one"
   check (`s.secretNames.includes(n)`) valid for both existing and new AD clients — no data migration.

### Runner

4. **Null-guard `directory-sync`** — `runner/Start-IamRunner.ps1:1036-1038` dereferences
   `($creds['ad-dc']).Credential` unconditionally; guard it so the lane works when `ad-dc` isn't
   brokered. `active-directory`, `ad-email-writeback`, `ad-consistency-check`, `ad-hard-match`
   already route through `New-CtgAdConnection` (ambient-safe, PR #69) and need no change.

### Fixing UM0029763 (Brock Built)

5. After the change ships: **re-plan** the case (`POST /api/cases/[id]/replan`) so its AD jobs
   drop `ad-dc` from `secretNames` and become claimable under ambient SYSTEM. Tidy Brock Built's
   broken `ad-dc` secret row (empty externalId → set to the `NOT_NEEDED` sentinel) so intent is
   explicit; functionally it's already a non-event once `ad-dc` is optional.

## Data / schema

No migration. Uses the existing `Job.request.secretNames` / `optionalSecretNames` split and the
`OPTIONAL_SECRETS` registry. Cleaning Brock Built's `ad-dc` row is a one-off data edit, not schema.

## Error handling

- Absent / not-needed / empty `ad-dc` → not brokered → AD runs ambient (DC) or fails at runtime
  with PR #69's clear message (member server). Never a broker-time 502 for AD again.
- `directory-sync` with no `ad-dc` → ambient (guarded).

## Testing

- **Web (tsx --test):**
  - the planner strips `ad-dc` from a job's required `secretNames` and, when the client wired it,
    surfaces it in `optionalSecretNames`; when unwired, it appears in neither;
  - an AD job with unset `ad-dc` is **claimable** (not counted `missingRequiredSecrets`);
  - re-plan of a case rewrites AD jobs without `ad-dc` in `secretNames`;
  - `spanning-portal` behaviour is unchanged (regression guard).
- **Runner (Pester):** `directory-sync` executes with `ad-dc` absent (ambient) and present (cred);
  the existing `New-CtgAdConnection`/AdConnection suite already covers the AD auth ladder.

## Acceptance

Test against **Brock Built**: with `ad-dc` unset/not-needed, re-plan UM0029763 → the
`active-directory` (and `directory-sync`, `ad-email-writeback`) jobs dispatch on the DC agent and
succeed via ambient SYSTEM, with no `ad-dc` broker attempt.

## Follow-ups (out of scope)

- An empty required `externalId` currently resolves toward secret `0` / `reference_missing` rather
  than being treated as cleanly unset — a latent trap for *other* required secrets. Worth a
  separate hardening pass.
