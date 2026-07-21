# Offboard: hide from GAL by default

**Feature request:** #0000021 "Offboardings - Hide From GAL" (author ccyr@core.tech,
filed 2026-07-21 from case `cmrut4txj003txb2nr43n5jfj` — an Ear, Nose & Throat Institute
of CT offboard). Requestor's exact ask:

> Hide from Global Address list not present
> `Set-Mailbox -Identity $currentUser.ID -HiddenFromAddressListsEnabled $true`

## Goal

On **every** offboarding, hide the departing user from the Global Address List by
default. A client, or a single case, can opt out ("unless the instructions say
specifically not to"). Cover the cloud mail systems (Exchange/EXO and M365) and Google
Workspace, and honor an existing on-prem Active Directory attribute when a client uses
one.

Terminology map (same concept, three names):

- Exchange / M365: **Global Address List (GAL)** — `HiddenFromAddressListsEnabled = $true`.
- Google Workspace: **contact sharing / directory sharing** — the Directory API user
  property `includeInGlobalAddressList = false` (note the **inverted** sense: `false`
  hides).
- On-prem AD: an attribute write, e.g. `msExchHideFromAddressLists = TRUE`, or for
  EXO-only-synced schemas `msDS-cloudExtensionAttribute1 = HideFromGAL`.

## The gap today

The GAL bit is flipped in exactly one place: the on-prem AD module
(`runner/modules/Coretelligent.ActiveDirectory/Coretelligent.ActiveDirectory.psm1:667`,
step 3 of `Invoke-CtgADOffboarding`, reading `config.hideFromGal {attribute, value}`, with
a read-back check at `:858`). Exchange/EXO, M365/Entra, and Google offboard executors
never touch it. `profiles/yuma.json:58` already declares `hideFromGal: true` on its
exchange lane and the Exchange module silently ignores it — a live example of the gap the
requestor hit.

## Design decision: planner-driven policy, runner executes

The "always hide unless told not to" decision, the opt-out precedence, and the AD-vs-EXO
routing all live in `resolveOffboardConfigs` (`web/lib/profiles/plan-resolve.ts:38`).
Runner modules stay dumb executors that honor a `hideFromGal` config key on the job.

Why here and not in the runner: the case `payload` is already an argument to
`resolveOffboardConfigs` (`plan-resolve.ts:38`, second param), so the per-case override is
free to read; the policy is visible in the plan preview and unit-testable in TypeScript;
and it follows two existing idioms in the same file — the OneDrive-delegate injection
(`plan-resolve.ts:64-77`) and the license base-union (`:259-271`). The alternative
(defaulting on inside each PowerShell module) would fragment the policy across three
modules and still needs the per-case flag threaded through the payload anyway.

## Policy

On every offboard, hide from the GAL by default. Opt-out precedence, highest first:

1. **Per-case override** — `payload.skipGalHide === true` (a new checkbox on the offboard
   case form). No hide on any lane for this case.
2. **Per-client opt-out** — the resolved offboard config carries `hideFromGal: false`
   (or `{ value: false }`) on the lane. No hide for this client.
3. **Default** — hide.

A truthiness normalizer (below) is the single source of truth for reading these shapes,
so `{ value: false }` and bare `false` both mean "do not hide" and never get
misread as a truthy object.

## Execution routing (decided in `resolveOffboardConfigs`)

`PlanClient` carries no `backbone`/`systems`, but the `planned: PlannedJob[]` array
carries `j.systemKey` and each job's resolved `config`. Topology is inferred from system
keys, exactly as the rest of the planner does it (`orchestrator.ts:81`,
`case-secrets.ts:29`). Routing:

- **If the AD offboard lane has a configured hide *attribute*** — the resolved
  `active-directory` job config carries `hideFromGal` with a concrete `attribute` (e.g.
  `{ attribute: "msExchHideFromAddressLists", value: "TRUE" }`, or Six One's
  `{ attribute: "msDS-cloudExtensionAttribute1", value: "HideFromGAL" }`) — then the **AD
  lane owns the hide**. Exchange/M365 does **not** also attempt. This is the "a client can
  select an AD attribute and it gets used" requirement, and it avoids the
  directory-synced-mailbox error on the EXO side. The planner detects this by reading the
  `active-directory` job's config for a `hideFromGal.attribute` (case-insensitive on the
  `hideFromGal` vs `hideFromGAL` key). Important: the AD module's existing step
  (`psm1:668-675`) only writes when `hideFromGal.attribute` is present — a bare
  `hideFromGal: true` on the AD lane is a no-op there, so it does **not** count as
  AD-owned and the EXO path (below) runs instead. This design does not change that AD
  behavior.
- **Otherwise** — inject `hideFromGal: true` onto the **exchange** lane. The runner runs
  `Set-Mailbox -HiddenFromAddressListsEnabled $true`. This works for cloud-native EXO and
  for full-hybrid on-prem Exchange. If EXO rejects it because the mailbox is
  directory-synced, the module emits a **WARN action line** ("couldn't hide from GAL —
  mailbox is directory-synced; set an AD hide attribute or hide manually") that surfaces on
  the run report.
- **Google** — inject `hideFromGal: true` onto the **google** lane → the runner sets
  `includeInGlobalAddressList = $false`.

**Why not an M365/Graph fallback:** `HiddenFromAddressListsEnabled` is an Exchange mailbox
property; Microsoft Graph does not expose it on the `user` resource. Only the EXO
`Set-Mailbox` cmdlet (which lives in `Coretelligent.Exchange`) can flip it. So the cloud
GAL hide can only run on the `exchange` lane, never on the `m365`/`entra` (Graph) lane. A
mailbox-bearing client is therefore expected to have an `exchange` ClientSystem — every
mailbox client checked (including the FR's own ENT client) does. If one somehow does not,
the cloud GAL hide simply can't run; that is a profile gap to fix by adding the `exchange`
system, not something to paper over on the Graph lane.

## Runner changes

All steps are idempotent (read live state, skip if already done, act, read back to
confirm) — the module convention, with convert-to-shared
(`Coretelligent.Exchange.psm1:776-842`) and block-sign-in
(`Coretelligent.M365.psm1:1247`) as the reference patterns.

### `Coretelligent.Exchange`
- New hide step in `Invoke-CtgExchangeOffboarding` (`psm1:698`), placed alongside
  convert-to-shared, gated on `$hasExoMailbox` (`:770`).
- Read `HiddenFromAddressListsEnabled` first; if already `$true`, emit action
  "already hidden from GAL" and skip the write.
- Else `Set-Mailbox -Identity <id> -HiddenFromAddressListsEnabled $true`, then read back
  and only then claim "hid from GAL" (same read-back discipline as
  `Test-CtgCloudMailboxShared`).
- Catch the directory-synced rejection (the "object is being synchronized / can't be
  modified" error family) → emit a **WARN** action line instead of failing the step.
- Config read through a new `Test-CtgHideFromGal` normalizer (modeled on
  `Test-CtgConvertToShared`, `psm1:295`) that treats `false` and `{ value: false }` as
  "do not hide."
- Add the read-back GAL assertion to the offboard confirm path (`Confirm-CtgExchange`).

### `Coretelligent.GoogleWorkspace`
- In `Invoke-CtgGoogleOffboarding` (`psm1:297`), set `includeInGlobalAddressList = $false`
  on the user (a field on the existing suspend `PUT /users/$email` body, or a dedicated
  PUT). Read current value first; skip if already `false`.
- Add the read-back to `Confirm-CtgGoogle` (`psm1:400`).

(No `Coretelligent.M365` change — Graph cannot set `HiddenFromAddressListsEnabled`, so the
cloud hide lives solely in `Coretelligent.Exchange`. See "Why not an M365/Graph fallback" above.)

### Versioning
- Bump `runner/VERSION` (minor — backward compatible; new config key, no protocol change).
  Runner needs deploy after merge.

## Web changes

### Planner — `web/lib/profiles/plan-resolve.ts`
- Extend `resolveOffboardConfigs` (`:38`) with GAL injection, following the
  delegate-injection idiom (`:64-77`): read `payload.skipGalHide`; determine whether the
  `active-directory` planned job already carries a `hideFromGal` attribute; then per lane
  set or skip `hideFromGal: true` on the resolved job config.
- New client-safe helper `resolveHideFromGal(config)` (mirrors the runner
  `Test-CtgHideFromGal`) that normalizes `true` / `false` / `{ value }` / `{ attribute }`
  and handles the `hideFromGal` vs `hideFromGAL` casing inconsistency
  (`coretelligent.json:227` uses capital GAL; six-one/yuma/marketscience use lowercase).

### Offboard case form — `web/app/cases/_components/cases-toolbar.tsx`
- Add one checkbox in the offboard-visible area (mirror the "Allowed to maintain email"
  checkbox at `:386`): "Keep in global address list (skip GAL hide)".
- Add `skipGalHide: f.get("skipGalHide") === "on"` to the offboard payload branch
  (`:315`). The payload is untyped end-to-end (`Record<string, unknown>`), so it rides
  through to `resolveOffboardConfigs` with no other plumbing.

### Client config editor — `web/app/clients/_components/systems-editor.tsx`
- Add a small structured control to the offboard section: a "Hide from GAL" default-on /
  force-off toggle, plus an optional "AD hide attribute" text field so a client can select
  the attribute (e.g. `msExchHideFromAddressLists`). Merge it over the per-lane JSON blob
  the same way `intent.offboard` and AD `onboard.ou` are special-cased today
  (`systems-editor.tsx:253-261`). Raw-JSON editing of the same keys keeps working.

### Schema / docs
- Add `hideFromGal` to the `m365OffboardConfig` `$def` (`profiles/_schema.json:369`).
  Exchange config has no validated `$def` (open-ended), so no schema change is needed
  there, but document the key in `docs/modules/exchange.md` (which already describes a
  `hideFromGal` exchange key as though it were wired).

### Run report
- No change needed: action lines and the WARN verdict surface automatically through
  `actionsOf` / `StepVerdict` in `web/lib/cases/run-report.ts`.

## Testing

- **Pester (runner):** Exchange hide — idempotent skip when already hidden; synced-mailbox
  error → WARN not failure; opt-out `false` → no write; read-back confirm. Google hide —
  set + skip-if-already + read-back.
- **TypeScript (web):** `resolveOffboardConfigs` injects on the right lane; the 3-level
  precedence (per-case > per-client > default); AD-attribute routing skips the EXO lane;
  `resolveHideFromGal` casing/shape normalization.

## Scope boundaries

- The cloud hide runs solely on the `exchange` lane (Graph can't set the GAL bit); there is
  no M365-lane path. A mailbox client is expected to have an `exchange` system.
- The per-client control is a **structured toggle** in `systems-editor`, not raw-JSON-only.
- No change to how AD does its existing attribute-based hide — the design routes to it and
  reuses it.

## Deployment notes

- `runner/VERSION` bump → runner needs deploy after merge.
- Prisma/DB: none — the case payload and lane config are JSON, no migration.
